export function ok(data = null, extra = {}) {
    return {
        code: 0,
        message: extra.message ?? 'success',
        data,
        total: extra.total ?? 0,
        elapsed_ms: extra.elapsedMs ?? 0,
        cache_hit: extra.cacheHit ?? false,
    };
}

export function fail(message = 'error', code = 400) {
    return {
        code,
        message,
        data: null,
        total: 0,
        elapsed_ms: 0,
        cache_hit: false,
    };
}
