export class BusinessError extends Error {
    constructor(message = '业务处理失败', code = 400) {
        super(message);
        this.name = 'BusinessError';
        this.code = code;
    }
}

export class NotFoundError extends BusinessError {
    constructor(message = '资源不存在') {
        super(message, 404);
        this.name = 'NotFoundError';
    }
}

export class QueryValidationError extends BusinessError {
    constructor(message = '查询参数非法') {
        super(message, 422);
        this.name = 'QueryValidationError';
    }
}

export class DatabaseError extends BusinessError {
    constructor(message = '数据访问失败') {
        super(message, 500);
        this.name = 'DatabaseError';
    }
}
