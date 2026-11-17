// 「测试连接」失败时的详情与排查建议（与主线版 tools-platform/backend/routes/ai-settings.js 的
// formatFailurePayload / buildConnectionHint 同一套口径）。所有地址、原文返回前都先脱敏。
import { redactText } from '../agent/redact.js';

const TIMEOUT_SECONDS = 90;

/** 去掉地址里的查询参数和用户名口令（有些网关把密钥放在 ?key= 里） */
export function sanitizeEndpointUrl(url, secrets = []) {
    try {
        const parsed = new URL(String(url || ''));
        parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
        return redactText(parsed.toString(), { secrets });
    } catch { return redactText(String(url || ''), { secrets }); }
}

function prettifyRawDetail(rawText = '', secrets = []) {
    const text = String(rawText || '').trim();
    if (!text) return '';
    if (/^\s*[[{]/.test(text)) {
        try { return redactText(JSON.stringify(JSON.parse(text), null, 2), { secrets }).slice(0, 4000); } catch { /* 不是完整 JSON：按纯文本 */ }
    }
    return redactText(text, { secrets }).slice(0, 4000);
}

export function buildConnectionHint({ httpStatus, upstreamStatus, causeCode, isTimeout, contentType, rawText, providerMessage, message }) {
    const raw = `${rawText || ''} ${providerMessage || ''} ${message || ''}`;
    const code = `${causeCode || ''} ${raw}`;
    if (isTimeout) return `连接或等待模型响应超过 ${TIMEOUT_SECONDS} 秒。请确认应用所在环境能否访问网关地址，以及网关当前负载是否过高。`;
    if (/DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_|ERR_TLS_/i.test(code)) {
        return 'HTTPS/TLS 证书校验失败（常见于内网自签或内部 CA 证书）。可在模型方案里取消勾选「校验 HTTPS 证书」，或为应用配置受信任的根证书。';
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(code)) return '域名解析失败，应用所在环境无法解析网关主机名。请检查 API URL 拼写，以及网关是否对本应用开放。';
    if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_/i.test(code)) return 'TCP 连接被拒绝、重置或超时。请检查 API URL 的协议和端口，以及网关的访问策略。';
    if (/<!doctype|<html/i.test(raw) || String(contentType || '').includes('text/html')) {
        return '接口返回了 HTML 页面或非 JSON 内容（例如网关拦截、登录页或路径不对）。请确认 API URL 填到 /v1 基地址，以及是否需要附加认证请求头。';
    }
    if ([401, 403].includes(upstreamStatus) || [401, 403].includes(httpStatus)) {
        return '鉴权失败或无权访问当前模型。请核对 API Token 是否正确、未过期、有目标模型权限，也可按网关要求切换「认证方式」（bearer / x-api-key / api-key / x-goog-api-key / custom）。';
    }
    if (upstreamStatus === 404) return '网关返回 404（路径或模型不存在）。请检查 API URL（OpenAI 兼容接口通常填到 /v1 即可）与模型名称拼写。';
    if (upstreamStatus === 429) return '触发网关限流或额度已用尽（429）。请稍后重试，或换用同一渠道下的其他模型。';
    if (/reasoning|思考过程/.test(raw)) return '已连通模型网关，但输出的 tokens 全部用于思考过程、没有生成正文。请调高「最大输出 Tokens」后重试。';
    if (upstreamStatus >= 500) return '上游模型网关返回 5xx（常见原因：模型名在该渠道不可用、网关不兼容某些参数，或上游服务异常）。可展开详情对照响应原文。';
    if ([400, 422].includes(upstreamStatus)) return '请求参数不被网关或模型接受。请展开详情查看上游错误字段，必要时在「高级 / 自定义协议」里调整默认字段。';
    return '请展开下方失败详情，检查请求地址、HTTP 状态与上游返回原文。';
}

/** 把 callAiCompletion 的失败结果整理成测试接口的返回体 */
export function formatTestFailure(res = {}, settings = {}, { secrets = [], request = {} } = {}) {
    const d = res.diagnostics || {};
    const scrub = (value) => redactText(String(value ?? ''), { secrets });
    const upstreamStatus = Number(d.upstreamStatus || res.status || 0) || null;
    const httpStatus = d.isTimeout ? 504 : (upstreamStatus && upstreamStatus >= 400 ? upstreamStatus : 502);
    const providerMessage = scrub(d.providerMessage);
    const causeCode = scrub(d.causeCode);
    let error = scrub(res.error || '模型测试失败');
    if (d.isTimeout) error = `连接模型超时（${res.latencyMs || 0}ms 未响应）`;
    else if (/^fetch failed$/i.test(String(res.error || '').trim()) && (causeCode || d.causeMessage)) error = `网络请求失败（${[causeCode, scrub(d.causeMessage)].filter(Boolean).join(': ')}）`;
    else if (upstreamStatus && providerMessage && !error.includes(providerMessage)) error = `上游返回 HTTP ${upstreamStatus}：${providerMessage}`;
    const rawDetail = prettifyRawDetail(d.rawBody || [res.error, causeCode && `code: ${causeCode}`, d.causeMessage && `cause: ${d.causeMessage}`].filter(Boolean).join('\n'), secrets);
    return {
        success: false,
        error,
        model: res.model,
        details: {
            provider: settings.provider || res.provider || '',
            model: res.model || settings.model || '',
            endpoint: sanitizeEndpointUrl(d.endpoint || '', secrets),
            httpStatus,
            upstreamStatus,
            upstreamStatusText: String(d.upstreamStatusText || ''),
            errorCode: scrub(d.providerCode || causeCode || (d.isTimeout ? 'REQUEST_TIMEOUT' : '')),
            ...(d.causeMessage ? { cause: scrub(d.causeMessage) } : {}),
            durationMs: res.latencyMs || 0,
            ...(d.contentType ? { contentType: String(d.contentType) } : {}),
            request,
            hint: buildConnectionHint({ httpStatus, upstreamStatus, causeCode, isTimeout: d.isTimeout, contentType: d.contentType, rawText: d.rawBody, providerMessage, message: res.error }),
            ...(rawDetail ? { rawDetail } : {}),
            timestamp: new Date().toISOString(),
        },
    };
}
