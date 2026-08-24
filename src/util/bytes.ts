// util/bytes.ts — 字节口径工具（R2-1/B-H01）
// JS 字符串 .length 返回 UTF-16 码元数（CJK 1 字=1 码元=3 UTF-8 字节），不是真实字节。
// 所有「预算 / 记账 / 节约台账」必须用 byteLen() 累计真实 UTF-8 字节，否则预算可超约 3 倍、数字失真。
export const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8')
