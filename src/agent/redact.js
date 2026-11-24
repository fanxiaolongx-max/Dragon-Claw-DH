// 统一脱敏：所有工具结果在交给模型之前都过一遍，避免把凭据、密钥送进模型或写进对话记录。
// 各工具自己也有边界（密钥表不可查、脚本请求头隐藏），这里是兜底。
const COMPOUND_ACCOUNT_PASSWORD = /(["']?(?:账号|用户(?:名)?|account|user(?:name)?)\s*(?:[/／&＆与和]|\s+)?(?:密码|口令|passwd|password)["']?\s*[:：=]\s*)(?!\[已隐藏\])([^\s/\\,;}\]<>]+)(\s*[/／:：|\s]\s*)(?!\[已隐藏\])([^\s,;}\]<>]+)/gi;

const PATTERNS = [
    // 键值形式：password=xxx、"token": "xxx"、Authorization: Bearer xxx、Cookie: a=b
    [/(https?:\/\/|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1$2:[已隐藏]@'],
    [/((?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|authorization|x-auth-token|x-csrf-token|cookie|set-cookie|密码|口令|密钥)["']?\s*[:=：]\s*["']?)(?:Bearer\s+)?([^\s"',;}{]{6,})/gi, '$1[已隐藏]'],
    [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/g, '$1 [已隐藏]'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[已隐藏的 JWT]'],
    [/\b(?:sk|pk|rk|ak)-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}/g, '[已隐藏的密钥]'],
    [/\bAKIA[0-9A-Z]{16}\b/g, '[已隐藏的密钥]'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已隐藏的私钥]'],
];

export function redactText(text, { secrets = [] } = {}) {
    let out = String(text ?? '');
    for (const secret of secrets) {
        const s = String(secret || '');
        if (s.length >= 6) out = out.split(s).join('[已隐藏]');
    }
    const preserved = [];
    out = out.replace(COMPOUND_ACCOUNT_PASSWORD, (_match, prefix, user, sep) => {
        const placeholder = `\u0000CRED_KEEP_${preserved.length}\u0000`;
        preserved.push(`${prefix}${user}${sep}[已隐藏]`);
        return placeholder;
    });
    for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
    if (preserved.length) {
        out = out.replace(/\u0000CRED_KEEP_(\d+)\u0000/g, (_, idx) => preserved[Number(idx)] ?? '');
    }
    return out;
}
