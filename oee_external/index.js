// 统一OEE外部访问层入口
// 把4个产线OEE库(功放1/2线·整机1/3线OEE)接进mes_dashboard的computeOEE漏斗,
// 提供"设备级真值"口径, 与主链"过站estimated"口径并列(原值保留进data_quality.estimated_*)。
// 默认关闭(OEE_EXTERNAL_ENABLED!=1); 开启前全站14个调用点行为零变化。
module.exports = require('./reader');
