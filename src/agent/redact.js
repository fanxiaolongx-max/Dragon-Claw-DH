// 内容脱敏已按用户要求整体取消（2026-11-27）：脱敏会把技能 / 工具结果里的普通文本误判成凭据，
// 严重影响使用。接口保留以兼容现有调用方，原样返回。
export function redactText(text) {
    return String(text ?? '');
}
