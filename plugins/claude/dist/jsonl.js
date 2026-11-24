import { closeSync, fstatSync, openSync, readSync } from "node:fs";
/**
 * Yields the lines of a file from last to first, reading fixed-size chunks
 * from the end, so the latest records of a large transcript cost only a tail read.
 */
export function* readLinesReverse(path, chunkSize = 1 << 20) {
    const fd = openSync(path, "r");
    try {
        let position = fstatSync(fd).size;
        let carry = Buffer.alloc(0);
        while (position > 0) {
            const size = Math.min(chunkSize, position);
            position -= size;
            const chunk = Buffer.alloc(size);
            readSync(fd, chunk, 0, size, position);
            const buf = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
            let end = buf.length;
            for (let i = buf.length - 1; i >= 0; i--) {
                if (buf[i] !== 0x0a)
                    continue;
                if (end > i + 1)
                    yield buf.toString("utf8", i + 1, end);
                end = i;
            }
            carry = buf.subarray(0, end);
        }
        if (carry.length > 0)
            yield carry.toString("utf8");
    }
    finally {
        closeSync(fd);
    }
}
/** Parses a JSONL line, returning undefined for blank or malformed lines. */
export function parseLine(line) {
    try {
        const value = JSON.parse(line);
        return value !== null && typeof value === "object" ? value : undefined;
    }
    catch {
        return undefined;
    }
}
