// 路由层需要的系统级能力（探活、调试探针、运行模式、键值配置）统一从这里取：
// 规范 §5.1 要求 routes 只调 service，不直接引用数据访问层。
export {
    scopedCheckHealth as checkDataHealth,
    isMemoryMode,
    debugProbeAction,
    kvGet as getSetting,
    kvSet as saveSetting,
} from '../dao/scoped.js';
