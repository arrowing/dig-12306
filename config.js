let config = {

  queryTypes: [
    'direct', // 直达
    'cross', // 跨站
    'patch', // 补票
    'transit', // 中转
    'mix' // 跨站 + 补票
  ],

  redis: {
    host: '127.0.0.1',
    port: 6379,
    directPre: 'direct',
    trainPre: 'train',
    queringPre: 'quering',
    trainTTL: 600 // 列车行程缓存时间，单位：秒
  },

  querySettings: {
    cross: 2, // 查询跨站、跨站 + 补票时候，最多可以跨的站数
    transitTime: [45, 75], // 单位：分钟，允许的中转时间，考虑班车延时，建议值：[45, 75]
    queringTTL: 120 // 单位：秒，查询中标识的生存时间，避免多人查询造成服务器压力过大
  },

  errcode: {
    ipLimit: 101, // 访问过快
    paramError: 102, // 参数错误

    // 错误码大于 200 的，可以在客户端重新发起请求
    failed: 201, // 请求 12306 失败
    serverError: 202, // 服务器错误
    timeout: 203, // 访问超时

    quering: 301 // 查询中，避免多人查询造成服务器压力过大
  },

  ipLimit: {
    keyPre: 'ip',
    times: 10, // 非负整数，单位时间内可以访问的次数，值为 0 时不做访问频率限制
    ttl: 60 // IP 地址访问记录释放时间，单位：秒，建议设置为 1 分钟，如果 times 为 10，则表示 1 分钟内访问接口次数大于 10 次则提示访问过快
  },

  retryTimes: {
    SID: 3 // JSESSIONID 更换重试次数
  }
}

module.exports = config