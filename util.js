const { promisify } = require('util')
const crypto = require('crypto')
const fs = require('fs')
let request = require('request')
let config = require('./config')
// let stationsGetName = require('./stations_code_to_name')
let stationsGetCode = require('./stations_name_to_code')
let redisClient
let redisHelper

const regDate = new RegExp('-', 'g')

request = request.defaults({
  method: 'GET',
  gzip: true,
  json: true,
  headers: {
    'Host': 'kyfw.12306.cn',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Accept': '*/*',
    'X-Requested-With': 'XMLHttpRequest',
    'If-Modified-Since': '0',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/77.0.3865.120 Safari/537.36',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Referer': 'https://kyfw.12306.cn/otn/leftTicket/init',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  }
})

const ONE_MINUTE = 60000
const TRANSIT_MIN_TIME = config.querySettings.transitTime[0] * ONE_MINUTE
const TRANSIT_Max_TIME = config.querySettings.transitTime[1] * ONE_MINUTE

let util = {

  // 查询：列车行程过站信息
  async queryByTrainNo (ctx, date, train) {
    let redisKey = `${config.redis.trainPre}:${date}:${train.train_no}`
    let trainInfo = []
    ctx.state.store = redisKey

    try{
      let info = await redisHelper.get(redisKey)

      if(info){
        trainInfo = JSON.parse(info)

      }else{
        let options = await util.getOptions(ctx, `https://kyfw.12306.cn/otn/czxx/queryByTrainNo?train_no=${train.train_no}&from_station_telecode=${train.from_station_telecode}&to_station_telecode=${train.to_station_telecode}&depart_date=${date}`)

        let res = await util.requestHelper(ctx, options)
        
        if(res && res.data && res.data.data){
          trainInfo = res.data.data
          redisClient.set(redisKey, JSON.stringify(trainInfo), 'EX', util.getExpireTTL(ctx, date))

        }else if(await util.retry(ctx)){
          return await util.queryByTrainNo(ctx, date, train)
        }
      }

      return trainInfo

    }catch(e){
      console.log('API queryByTrainNo error:', e)
      
      if(await util.retry(ctx)){
        return await util.queryByTrainNo(ctx, date, train)
      }

      return trainInfo
    }
    
  },

  // 查询：直达班次座位信息
  async directQuery (ctx, date, from, to) {
    let redisKey = `${config.redis.directPre}:${date}:${from}:${to}`
    let trainList = []
    ctx.state.store = redisKey

    try{
      let info = await redisHelper.get(redisKey)
      if(info){
        trainList = JSON.parse(info)

      }else{
        
				let queryKey
				try{
					queryKey = fs.readFileSync('query_key')
				}catch(e){
					// nothing to do
				}

        let options = await util.getOptions(ctx, `https://kyfw.12306.cn/otn/leftTicket/query${queryKey ? queryKey : ''}?leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${from}&leftTicketDTO.to_station=${to}&purpose_codes=ADULT`)
        let res = await util.requestHelper(ctx, options)

        if(res && res.data){

          if(res.data.result.length){
            trainList = util.resolve(res.data.result, res.data.map)
            trainList = util.filterNearbyStation(trainList, from, to)
          }
          redisClient.set(redisKey, JSON.stringify(trainList), 'EX', config.redis.trainTTL)

        }else if(await util.retry(ctx)){
          return await util.directQuery(ctx, date, from, to)
        }
      }

      return trainList

    }catch(e){
      console.log('API directQuery error:', e)

      if(await util.retry(ctx)){
        return await util.directQuery(ctx, date, from, to)
      }

      return trainList
    }
  },
  
  async crossQuery (ctx, date, directTrainListOrLines, trainNos, fromCode) {
    let queriedTrainList = []
    let allCrossLines = []

    let directTrainList
    let lines

    if(fromCode){
      // 跨站 + 补票查询
      lines = directTrainListOrLines
      for(let i = 0, len = lines.length; i < len; i++){
        let line = lines[i]
        let crossLines = util.getCrossLines({
          from_station_telecode: fromCode,
          to_station_telecode: line[line.length - 1]
        }, line, fromCode)

        allCrossLines = allCrossLines.concat(crossLines) // 得到所有横跨起始站，又不到目标站的班车
      }

    }else{ 
      // 跨站查询
      directTrainList = directTrainListOrLines
      for(let i = 0, len = directTrainList.length; i < len; i++){
        let train = directTrainList[i]
        let trainInfo = await util.queryByTrainNo(ctx, date, train) // trainInfo 为列车行程表，内容见 "data/查询单次班车.js"
        
        if(trainInfo && trainInfo.length){
          allCrossLines = allCrossLines.concat( util.getCrossLines(train, trainInfo) ) // 得到所有横跨起始站、终点站的班车
        }
      }
    }
    
    allCrossLines = new Set(allCrossLines) // 去重
    for(let line of allCrossLines){
      let trainList = await util.directQuery(ctx, date, ...line.split(':'))

      if(trainList && trainList.length){
        trainList = trainList.filter(train => trainNos.indexOf(train.train_no) > -1) // 必须要在直达车次列表里，不然可能到不了目的地，需要进行过滤
        queriedTrainList = queriedTrainList.concat(trainList)
      }
    }

    return queriedTrainList
  },

  async patchQuery (ctx, date, directTrainList, trainNos) {
    let queriedTrainList = []
    let allPatchTrainList = []

    for(let i = 0, len = directTrainList.length; i < len; i++){
      let train = directTrainList[i]

      let line = await util.queryByTrainNo(ctx, date, train) // 得到车次行程

      if(line && line.length){
        line = line.map(station => stationsGetCode[station.station_name]) // 得到班次的车站 code 列表
      }else{
        continue
      }

      let fromIndex = line.indexOf(train.from_station_telecode)
      let toIndex = line.lastIndexOf(train.to_station_telecode)

      if(toIndex - fromIndex <= 1){ // 只有一站之隔，已经在直达列表里有了，这里不再做处理
        continue
      }

      let toArr = line.slice(fromIndex + 1, toIndex)
      toArr.reverse() // 倒序排列，为了优先级展示
      .forEach(toStation => {
        allPatchTrainList.push(`${train.from_station_telecode}:${toStation}`)
      })
    }

    allPatchTrainList = new Set(allPatchTrainList) // 去重
    for(let line of allPatchTrainList){
      let trainList = await util.directQuery(ctx, date, ...line.split(':'))
      if(trainList && trainList.length){
        trainList = trainList.filter(train => trainNos.indexOf(train.train_no) > -1) // 必须要在直达车次列表里，不然可能到不了目的地，需要进行过滤
        queriedTrainList = queriedTrainList.concat(trainList)
      }
    }

    return queriedTrainList
  },

  async transitQuery (ctx, date, patchTrainList, toCode) {
    let transitTrainList = []
    let allTransitTrainLines = []
    let transitTrainLinesByFrom = {} // 所有可能中转的列车班次

    // 获取中转班车列表
    // 包括 [中间站 -> 目标站] 的所有行程列表
    for(let i = 0, len = patchTrainList.length; i < len; i++){
      let train = patchTrainList[i]
      train.transitDate = util.getTransitDate(date, train)

      allTransitTrainLines.push(`${train.transitDate}:${train.to_station_telecode}:${toCode}`) // 首发车次的终点为中转车次的起点
    }

    allTransitTrainLines = new Set(allTransitTrainLines) // 去重
    for(let line of allTransitTrainLines){
      let [transitDate, from, to] = line.split(':')
      let trainList = await util.directQuery(ctx, transitDate, from, to)

      if(trainList && trainList.length){
        if(!transitTrainLinesByFrom[transitDate]){
          transitTrainLinesByFrom[transitDate] = {}
        }

        transitTrainLinesByFrom[transitDate][from] = trainList
      }
    }

    transitTrainList = patchTrainList.map(train => {
      let firstArriveStamp = +new Date(`${train.transitDate} ${train.arrive_time}`) // 首发车次到达时间戳
      let secondLines = transitTrainLinesByFrom[train.transitDate][train.to_station_telecode] // 首发车次的终点为中转车次的起点

      if(secondLines && secondLines.length){
        for(let i = 0, len = secondLines.length; i < len; i++){
          let line = secondLines[i]
          let secondFireStamp = +new Date(`${train.transitDate} ${line.start_time}`) // 中转车次发车时间戳

          let transitTime = secondFireStamp - firstArriveStamp
          if(transitTime >= TRANSIT_MIN_TIME && transitTime <= TRANSIT_Max_TIME){ // 符合中转休息时间规定
            line.transit_start_date = train.transitDate.replace(regDate, '')
            return [train, line]
          }
        }
      }

      return []
    })

    transitTrainList = transitTrainList.filter(transit => transit.length) // 过滤没有中转班次的线路

    return transitTrainList
  },

  async mixQuery (ctx, date, directTrainList, trainNos) {
    let mixTrainList
    let lines = []
    let fromCode
    let fromIndex
    let toIndex

    for(let i = 0, len = directTrainList.length; i < len; i++){
      let train = directTrainList[i]
      fromCode = train.from_station_telecode

      let trainInfo = await util.queryByTrainNo(ctx, date, train) // trainInfo 为列车行程表，内容见 "data/查询单次班车.js"

      if(!trainInfo || trainInfo.length === 0){
        continue
      }

      let line = trainInfo.map(station => stationsGetCode[station.station_name])
      
      fromIndex = line.indexOf(fromCode)
      if(fromIndex === 0){ // 假如列车行程第一个站就是起始站，不做处理，已在补票列表里
        continue
      }

      toIndex = line.lastIndexOf(train.to_station_telecode)

      while(toIndex - fromIndex > 1){ // 终点站不能与起始站相邻，此种情况已经在跨站列表里做处理
        line = line.slice(0, toIndex)
        lines.push(line)
        toIndex-- // 终点站往前挪一个站
      }
    }

    if(lines.length){
      mixTrainList = await util.crossQuery(ctx, date, lines, trainNos, fromCode)
    }else{
      mixTrainList = []
    }

    return mixTrainList
  },

  getCrossLines (train, line, isMixQuery) {
    let crossLength = config.querySettings.cross // 最多跨 ${config.querySettings.cross} 个站买票
    isMixQuery = !!isMixQuery
    
    if(!isMixQuery){
      // 转成 code 处理
      line = line.map(station => stationsGetCode[station.station_name])
    }
    
    // 跨站列车表优先级排序
    let lines = {
      lvl1: [],
      lvl2: []
    }

    let fromIndex = line.indexOf(train.from_station_telecode)
    let toIndex = line.indexOf(train.to_station_telecode)
    let startIndex = 0

    if(fromIndex - crossLength > startIndex){
      startIndex = fromIndex - crossLength
    }

    let avaliableLength
    let priority

    for(let i = startIndex; i <= fromIndex; i++){

      if(isMixQuery){
        // 跨站 + 补票
        if(i < fromIndex){
          lines['lvl1'].push(`${line[i]}:${train.to_station_telecode}`) // 终点站必为票程终点站，mixQuery 方法中已对 line 做过终点站处理
        }else{
          break // 起点站 -> 中途站，不做处理，补票列表里已有
        }
        
      }else{
        // 跨站

        avaliableLength = crossLength - (fromIndex - i) // 还剩余的可用站点长度
        // avaliableLength = 0 直达终点站
        // avaliableLength > 0 跨越终点站
  
        if(i === fromIndex && avaliableLength === 0){ // 起始站 -> 终点站，已经在直达列表里，这里不再做处理
          continue
        }
  
        if(i < fromIndex){ // 起始站比最佳起始站靠前，优先级较低
          priority = 'lvl2'
  
        }else{ // 起始站就是最佳起始站，优先级较高
          priority = 'lvl1'
        }

        if(avaliableLength){ // 目标站即是列车终点站，无站可跨
          line.slice(i - 1, fromIndex).forEach(station => {
            lines[priority].push(`${station}:${line[toIndex]}`) 
          })

        }else{
          line.slice(toIndex + 1, toIndex + avaliableLength).forEach(station => {
            lines[priority].push(`${line[i]}:${station}`) 
          })
        }
        
      }

    }

    return lines.lvl1.concat(lines.lvl2)
  },

  getExpireTTL (ctx, date) {
    if(!ctx.state.ttl){
      ctx.state.ttl = Math.floor( (new Date(date).getTime() + 3600000 * 24 - Date.now() ) / 1000 ) // (发车时间当天晚上 23:59:59 的时间戳 - 当前时间戳) / 1000 = 过期秒数
    }

    return ctx.state.ttl
  },

  async retry (ctx) {
    ctx.state.JSESSIONID = util.getRandomJSESSIONID() // 生成新的 SID

    if(ctx.state.SID_times){
      if(++ctx.state.SID_times > config.retryTimes.SID){ // 超过更换 SID 的次数，则返回 false
        return false
      }

    }else{
      ctx.state.SID_times = 1
    }

    return true
  },

  // 将时间对象格式化为字符串，如 2019-10-29 18:14:00
  formatTime (date, isDate) {
    if(!isNaN(date)){
      date = new Date(date)
    }

    let dateStr = ''

    let year = date.getFullYear(),
      month = date.getMonth() + 1,
      day = date.getDate();

    dateStr = [year, month, day].map(util.formatNumber).join('-')

    if(isDate) {
      return dateStr
    }

    let hour = date.getHours(),
      minute = date.getMinutes(),
      second = date.getSeconds();

    dateStr += ' ' + [hour, minute, second].map(util.formatNumber).join(':')
    return  dateStr 
  },
  
  // 格式化时间相关数字，加入前导 0
  formatNumber (n) {
    n = n.toString();
    return n[1] ? n : '0' + n;
  },

  // 有时候中转需要跨天，获取中转列车的出行时间
  getTransitDate (date, train) {
    let start = train.start_time.split(':')
    let lishi = train.lishi.split(':')
    let endHour = +start[0] + +lishi[0] + (+start[1] + +lishi[1] >= 60 ? 1 : 0)

    let crossDays = Math.floor(endHour / 24) // 跨越的天数
    if(crossDays >= 1){ // 跨天
      let dateObj = new Date(date)
      dateObj.setTime(dateObj.getTime() + crossDays * 3600000 * 24)
      date = util.formatTime(dateObj, true)
    }

    return date
  },
  
  createRedisClient () {
    const redis = require("redis")
    redisClient = redis.createClient(config.redis)
    redisClient.on("error", function (err) {
      console.log("Reids error", err);
    });

    redisHelper = {
      get: promisify(redisClient.get).bind(redisClient),
      ttl: promisify(redisClient.ttl).bind(redisClient),
      srandmember: promisify(redisClient.srandmember).bind(redisClient),
      smembers: promisify(redisClient.smembers).bind(redisClient),
      scard: promisify(redisClient.scard).bind(redisClient)
    }

    return {
      redisClient,
      redisHelper
    }
  },

  getRealIP (ctx) {
    let ipAddress = ctx.headers['x-real-ip'] // ng 代理后的新头部

    if(!ipAddress){ // 如果没有 ng
      ipAddress = ctx.headers['x-real-ip'] = ctx.req.connection.remoteAddress
    }

    return ipAddress
  },

  getLimitKey (ip) {
    return `${config.ipLimit.keyPre}:${ip}`
  },

  // 限定 IP 访问频率
  async ipLimit (ctx, next) {
    if(config.ipLimit.times === 0){
      await next()

    }else{
      let ipAddress = util.getRealIP(ctx)
      let redisKey = util.getLimitKey(ipAddress)
      let times = await redisHelper.get(redisKey) || 0
      let leftTTL = times === 0 ? config.ipLimit.ttl : await redisHelper.ttl(redisKey)
  
      if(times < config.ipLimit.times){
        times++
        redisClient.set(redisKey, times, 'EX', leftTTL)
        await next()
      }else{
        util.busy(ctx, 'ipLimit')
      }
    }
    
  },

  // IP 单位时间内访问次数减少 num，目前用于系统查询中，不计用户当前访问数
  async limitDown (ip, num = 1) {
    let redisKey = util.getLimitKey(ip)
    let times = await redisHelper.get(redisKey) || 0

    times -= num
    if(times >= 0){
      let leftTTL = await redisHelper.ttl(redisKey)
      redisClient.set(redisKey, times, 'EX', leftTTL)
    }
  },

  getRandomJSESSIONID () {
    const md5 = crypto.createHash('md5')
    return md5.update(Math.random().toString()).digest('hex').toUpperCase()
  },

  async getOptions (ctx, url) {

    let options = {
      url,
      headers: { 
        'Cookie': `JSESSIONID=${ctx.state.JSESSIONID}`
      }
    }

    return options
  },

  requestHelper (ctx, options) {
    let retryInfo = ctx.state.SID_times ? ` (${ctx.state.SID_times}/${config.retryTimes.SID})` : ''
    let proxyInfo = options.proxy ? ` [By ${options.proxy}]` : ''
    
    return new Promise(function(resolve, reject) {
      let startTime = Date.now()
      let requestObj = request(options, function (error, response, body) {
        console.log(`[${ctx.state.type} - ${ctx.state.store}]${proxyInfo}${retryInfo} - ${Date.now() - startTime}ms`)

        if(error){
          let errMsg = {
            code: error.code // ESOCKETTIMEDOUT / ECONNRESET
          }
          reject(errMsg)
        }else{
          resolve(body)
        }
      })
    })
  },

  getQueringKey (ctx, date, from, to) {
    return `${config.redis.queringPre}:${ctx.state.type}:${date}:${from}:${to}`
  },

  async getQueringFlag (redisKey) {
    let flag = await redisHelper.get(redisKey)
    return +flag === 1
  },

  setQueringFlag (redisKey, isDel = false) {
    if(isDel){
      redisClient.del(redisKey)
    }else{
      redisClient.set(redisKey, 1, 'EX', config.querySettings.queringTTL)
    }
  },

  checkType (type) {
    return config.queryTypes.indexOf(type) > -1
  },

  checkDate (dateStr) {
    if(!dateStr || typeof dateStr !== 'string') return false

    let dateArr = dateStr.split('-')
    if(dateArr.length !== 3) return false

    let selectDate = new Date(dateStr)
    let nowDate = new Date()
    let minDate = new Date(`${nowDate.getFullYear()}-${nowDate.getMonth() + 1}-${nowDate.getDate()}`)
    let maxDate = minDate + 29 * 3600000 * 24
    if(
      selectDate.toString() === 'Invalid Date' ||
      selectDate < minDate || nowDate > maxDate
    ){
      console.log('Date param error', dateStr)
      return false
    }

    return true
  },

  checkStation (from, to) {
    if(
      from === to ||
      !stationsGetCode[from] ||
      !stationsGetCode[to]
    ){
      return false
    }

    return true
  },

  filterNearbyStation (trainList, from, to) {
    trainList = trainList.filter(item => {
      return item.from_station_telecode === from && item.to_station_telecode === to
    })

    return trainList
  },

  resolve (cO, cQ) {
    var cN = [];
    for (var cM = 0; cM < cO.length; cM++) {
        // var cR = [];
        var cL = cO[cM].split("|");

        if(cL[11] === 'IS_TIME_NOT_BUY'){ // 列车停运
          continue
        }

        // cR.secretStr = cL[0]; // 加密串："9Z5oXeFVNbkEurPR2c57MSAa8O39QGDG7hNw1n3MZGfphyuLAWaQhtn7unXs00sXZzWP9tdSeESW%0AA5G47LirQpN4gCznUYOdfgPp31vBZB6tiQ6Lyk1ly50sul72HO0bAjTAbNk%2BKTAf4gPHJ8v7kAcu%0AnH4yIEmPp6VlZ%2FGz1mVI5MJ3Q%2F8KEYG386nEkJlqyS6OauwD1KE1EdOOeQ7K941gPu0kSVq90c3Q%0AUgm%2F5bh%2Bav4SyaaBUmR2FiM%2B4DI9SAjsvQIp4JFJdiDJkGl%2FP8gAftkWwozX3bUZuOm17Kc%3D"
        // cR.buttonTextInfo = cL[1]; // 预订
        var cP = {};
        cP.train_no = cL[2];
        cP.station_train_code = cL[3];
        cP.start_station_telecode = cL[4];
        cP.end_station_telecode = cL[5];
        cP.from_station_telecode = cL[6];
        cP.to_station_telecode = cL[7];
        cP.start_time = cL[8];
        cP.arrive_time = cL[9];
        cP.lishi = cL[10];
        cP.canWebBuy = cL[11];
        cP.yp_info = cL[12];
        cP.start_train_date = cL[13];
        cP.train_seat_feature = cL[14];
        cP.location_code = cL[15];
        cP.from_station_no = cL[16];
        cP.to_station_no = cL[17];
        cP.is_support_card = cL[18];
        cP.controlled_train_flag = cL[19];
        cP.gg_num = cL[20] ? cL[20] : "--";
        cP.gr_num = cL[21] ? cL[21] : "--";
        cP.qt_num = cL[22] ? cL[22] : "--";
        cP.rw_num = cL[23] ? cL[23] : "--";
        cP.rz_num = cL[24] ? cL[24] : "--";
        cP.tz_num = cL[25] ? cL[25] : "--";
        cP.wz_num = cL[26] ? cL[26] : "--";
        cP.yb_num = cL[27] ? cL[27] : "--";
        cP.yw_num = cL[28] ? cL[28] : "--";
        cP.yz_num = cL[29] ? cL[29] : "--";
        cP.ze_num = cL[30] ? cL[30] : "--";
        cP.zy_num = cL[31] ? cL[31] : "--";
        cP.swz_num = cL[32] ? cL[32] : "--";
        cP.srrb_num = cL[33] ? cL[33] : "--";
        cP.yp_ex = cL[34];
        cP.seat_types = cL[35];
        cP.exchange_train_flag = cL[36];
        cP.houbu_train_flag = cL[37];
        if (cL.length > 38) {
            cP.houbu_seat_limit = cL[38]
        }
        cP.from_station_name = cQ[cL[6]];
        cP.to_station_name = cQ[cL[7]];
        // cR.queryLeftNewDTO = cP;
        cN.push(cP)
    }
    return cN
  },

  busy (ctx, type = 'failed') {

    type === 'ipLimit' && console.log(`用户访问受限: ${util.getRealIP(ctx)}`)
    type === 'paramError' && console.log(`参数错误: ${util.getRealIP(ctx)} - ${JSON.stringify(ctx.params)}`)

    ctx.body = {
      errcode: config.errcode[type],
      errmsg: `访问频率过快，请稍后访问`,
      data: null
    }

    return false
  },

  stationsGetCode
}

module.exports = util