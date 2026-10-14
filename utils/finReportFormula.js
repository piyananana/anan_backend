// File: utils/finReportFormula.js
// Safe formula parser/evaluator for financial report FORMULA columns.
// Replaces `new Function()` — only arithmetic, cell refs and a fixed function list are allowed.
//
// Syntax:
//   cell ref : (R100, C20)          → value of row_seq_no 100, column_seq_no 20
//   operators: + - * /  unary -  ( )
//   functions: ABS(x)  ROUND(x[, digits])  MIN(a, b, ...)  MAX(a, b, ...)
//   numbers  : 123  1.5  .5
// Division by zero yields null (displayed as blank/'-'), and null propagates through arithmetic.

class FormulaError extends Error {
    constructor(code, message, detail = {}) {
        super(message);
        this.code = code;     // SYNTAX | UNKNOWN_REF | NOT_NUMERIC | CIRCULAR | REF_ERROR
        this.detail = detail; // e.g. { row: 100, col: 20 }
    }
}

const FUNCTIONS = {
    ABS:   { min: 1, max: 1 },
    ROUND: { min: 1, max: 2 },
    MIN:   { min: 1, max: Infinity },
    MAX:   { min: 1, max: Infinity },
};

const REF_RE = /^\(\s*R(\d+)\s*,\s*C(\d+)\s*\)/i;

const tokenize = (text) => {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (/\s/.test(ch)) { i++; continue; }

        const rest = text.slice(i);
        const ref = REF_RE.exec(rest);
        if (ref) {
            tokens.push({ type: 'REF', row: parseInt(ref[1], 10), col: parseInt(ref[2], 10), pos: i });
            i += ref[0].length;
            continue;
        }

        const num = /^(\d+\.?\d*|\.\d+)/.exec(rest);
        if (num) {
            tokens.push({ type: 'NUM', value: parseFloat(num[1]), pos: i });
            i += num[0].length;
            continue;
        }

        const ident = /^[A-Za-z_]\w*/.exec(rest);
        if (ident) {
            tokens.push({ type: 'IDENT', value: ident[0].toUpperCase(), pos: i });
            i += ident[0].length;
            continue;
        }

        if ('+-*/(),'.includes(ch)) {
            tokens.push({ type: ch, pos: i });
            i++;
            continue;
        }

        throw new FormulaError('SYNTAX', `Unexpected character '${ch}' at position ${i + 1}`, { pos: i + 1 });
    }
    tokens.push({ type: 'EOF', pos: text.length });
    return tokens;
};

// Recursive-descent parser → AST
//   expr  := term (('+'|'-') term)*
//   term  := unary (('*'|'/') unary)*
//   unary := ('+'|'-') unary | primary
//   primary := NUM | REF | IDENT '(' args ')' | '(' expr ')'
const parse = (text) => {
    if (text == null || String(text).trim() === '') {
        throw new FormulaError('SYNTAX', 'Formula is empty');
    }
    const tokens = tokenize(String(text));
    let p = 0;
    const peek = () => tokens[p];
    const next = () => tokens[p++];
    const expect = (type) => {
        const t = next();
        if (t.type !== type) {
            throw new FormulaError('SYNTAX', `Expected '${type}' at position ${t.pos + 1}`, { pos: t.pos + 1 });
        }
        return t;
    };

    const parseExpr = () => {
        let node = parseTerm();
        while (peek().type === '+' || peek().type === '-') {
            const op = next().type;
            node = { type: 'BIN', op, left: node, right: parseTerm() };
        }
        return node;
    };

    const parseTerm = () => {
        let node = parseUnary();
        while (peek().type === '*' || peek().type === '/') {
            const op = next().type;
            node = { type: 'BIN', op, left: node, right: parseUnary() };
        }
        return node;
    };

    const parseUnary = () => {
        if (peek().type === '-') { next(); return { type: 'NEG', arg: parseUnary() }; }
        if (peek().type === '+') { next(); return parseUnary(); }
        return parsePrimary();
    };

    const parsePrimary = () => {
        const t = next();
        if (t.type === 'NUM') return { type: 'NUM', value: t.value };
        if (t.type === 'REF') return { type: 'REF', row: t.row, col: t.col };
        if (t.type === '(') {
            const node = parseExpr();
            expect(')');
            return node;
        }
        if (t.type === 'IDENT') {
            const fn = FUNCTIONS[t.value];
            if (!fn) throw new FormulaError('SYNTAX', `Unknown function '${t.value}'`, { pos: t.pos + 1 });
            expect('(');
            const args = [];
            if (peek().type !== ')') {
                args.push(parseExpr());
                while (peek().type === ',') { next(); args.push(parseExpr()); }
            }
            expect(')');
            if (args.length < fn.min || args.length > fn.max) {
                throw new FormulaError('SYNTAX', `Wrong number of arguments for ${t.value}()`, { pos: t.pos + 1 });
            }
            return { type: 'FN', name: t.value, args };
        }
        if (t.type === 'EOF') throw new FormulaError('SYNTAX', 'Formula ended unexpectedly', { pos: t.pos + 1 });
        throw new FormulaError('SYNTAX', `Unexpected '${t.type}' at position ${t.pos + 1}`, { pos: t.pos + 1 });
    };

    const ast = parseExpr();
    if (peek().type !== 'EOF') {
        throw new FormulaError('SYNTAX', `Unexpected '${peek().type}' at position ${peek().pos + 1}`, { pos: peek().pos + 1 });
    }
    return ast;
};

// Evaluate an AST. resolveRef(row, col) must return a number or null (or throw FormulaError).
const evaluate = (ast, resolveRef) => {
    const ev = (n) => {
        switch (n.type) {
            case 'NUM': return n.value;
            case 'REF': return resolveRef(n.row, n.col);
            case 'NEG': { const v = ev(n.arg); return v == null ? null : -v; }
            case 'BIN': {
                const l = ev(n.left);
                const r = ev(n.right);
                if (l == null || r == null) return null;
                if (n.op === '+') return l + r;
                if (n.op === '-') return l - r;
                if (n.op === '*') return l * r;
                return r === 0 ? null : l / r;
            }
            case 'FN': {
                const vals = n.args.map(ev);
                if (n.name === 'ABS')   return vals[0] == null ? null : Math.abs(vals[0]);
                if (n.name === 'ROUND') {
                    if (vals[0] == null) return null;
                    const f = Math.pow(10, vals.length > 1 && vals[1] != null ? Math.trunc(vals[1]) : 0);
                    return Math.round(vals[0] * f) / f;
                }
                const nums = vals.filter(v => v != null);
                if (nums.length === 0) return null;
                return n.name === 'MIN' ? Math.min(...nums) : Math.max(...nums);
            }
            default:
                throw new FormulaError('SYNTAX', `Unknown node '${n.type}'`);
        }
    };
    return ev(ast);
};

module.exports = { parse, evaluate, FormulaError };
