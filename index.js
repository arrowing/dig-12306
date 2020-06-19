const Koa = require('koa')
const app = new Koa()
const Router = require('koa-router')
const router = new Router()
const compress = require('koa-compress')
const util = require('./util')

app.use(util.ipLimit)

app.use(async (ctx, next) => {
  try {
    let startTime = Date.now()
    await next()
    console.log(`[${ctx.headers['x-real-ip'] || ctx.req.connection.remoteAddress}] ${ctx.method} ${ctx.url} - ${Date.now() - startTime}ms`)
  } catch (e) {
    console.log('服务器错误:', e)
    util.busy(ctx, 'serverError')
  }
})

router.get('/query/:type/:date/:from/:to', async (ctx, next) => {
  let {type, date, from, to} = ctx.params

  // 中文解码
  from = decodeURIComponent(from)
  to = decodeURIComponent(to)

  if(
    util.checkType(type) &&
    util.checkDate(date) && 
    util.checkStation(from, to)
  ){

    ctx.state.type = type
    ctx.state.JSESSIONID = util.getRandomJSESSIONID()

    // 车站名称转换为 code
    from = util.stationsGetCode[from]
    to = util.stationsGetCode[to]

    // API 参数构造
    let trainList // 返回的列车列表
    let directTrainList
    let patchTrainList
    let trainNos
    let args = [ctx, date, from, to]

    let queringKey = util.getQueringKey(...args)
    let queringFlag = await util.getQueringFlag(queringKey)

    if(queringFlag){
      await util.limitDown(util.getRealIP(ctx), 1) // 不计入频率限制里
      return util.busy(ctx, 'quering')
    }else{
      util.setQueringFlag(queringKey) // 设置查询中标识
    }

    // 非直达接口前置查询
    if(type !== 'direct'){
      // 除了直达接口自己，其他接口都依赖于直达列车的接口
      directTrainList = await util.directQuery(...args)
      trainNos = directTrainList.map(train => train.train_no)

      // 更改 API 参数
      args = [ctx, date, directTrainList, trainNos]

      // 假如要查的是中转的班车列表，还需要先查出补票的班车列表
      // 中转列车查询较耗性能，需要做多个前置依赖查询
      if(type === 'transit'){
        patchTrainList = await util.patchQuery(...args)
        args = [ctx, date, patchTrainList, to] // 与其他接口的后面 2 个参数不同
      }
    }

    // trainList 是一个数组，如请求或者网络有问题，这将是个空数组
    // directQuery/crossQuery/patchQuery/transitQuery/mixQuery
    trainList = await util[`${type}Query`](...args)

    ctx.body = {
      data: trainList,
      errcode: 0,
      errmsg: null
    }

    util.setQueringFlag(queringKey, true) // 删除查询中标识
    
  }else{
    util.busy(ctx, 'paramError')
  }
  
})

// 初始操作
util.createRedisClient()

let serverPort = process.env.PORT || 3000

app
  .use(compress())
  .use(router.routes())
  .use(router.allowedMethods())
  .listen(serverPort)

console.log(`The server has started on port: ${serverPort}`)