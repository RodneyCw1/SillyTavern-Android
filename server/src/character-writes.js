const pending = new Map();

// Hold the queue through the complete read/modify/write operation.
export async function runCharacterWrite(key, operation) {
    const previous = pending.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    pending.set(key, current);
    try { return await current; }
    finally { if (pending.get(key) === current) pending.delete(key); }
}

export function serializeCharacterWrites(handler) {
    return (request, response) => runCharacterWrite(request.user.directories.characters,
        () => handler(request, response)).catch(error => {
        console.error('Character save failed:', error);
        if (!response.headersSent) response.sendStatus(500);
    });
}
