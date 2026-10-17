import fs from 'node:fs';
import { Buffer } from 'node:buffer';

import encode from './png/encode.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

/**
 * Reads a tEXt keyword without building a string for its potentially large payload.
 * @param {Uint8Array} bytes PNG text chunk data
 * @returns {{ keyword: string, text: Buffer }} Text chunk fields
 */
function textChunk(bytes) {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const separator = data.indexOf(0);
    const keywordEnd = separator < 0 ? data.length : separator;
    const text = data.subarray(separator < 0 ? data.length : separator + 1);
    if (text.includes(0)) {
        throw new Error('Invalid NULL character found. 0x00 character is not permitted in tEXt content');
    }
    return { keyword: data.toString('latin1', 0, keywordEnd).toLowerCase(), text };
}

/**
 * Writes Character metadata to a PNG image buffer.
 * Replaces both 'chara' and 'ccv3' metadata, preserving other PNG chunks.
 * @param {Buffer} image PNG image buffer
 * @param {string} data Character data to write
 * @returns {Buffer} PNG image buffer with metadata
 */
export const write = (image, data) => {
    const chunks = extract(image);
    const tEXtChunks = chunks.filter(chunk => chunk.name === 'tEXt');

    // Remove existing tEXt chunks
    for (const tEXtChunk of tEXtChunks) {
        const { keyword } = textChunk(tEXtChunk.data);
        if (keyword === 'chara' || keyword === 'ccv3') {
            chunks.splice(chunks.indexOf(tEXtChunk), 1);
        }
    }

    // Add new v2 chunk before the IEND chunk
    const base64EncodedData = Buffer.from(data, 'utf8').toString('base64');
    chunks.splice(-1, 0, PNGtext.encode('chara', base64EncodedData));

    // Try adding v3 chunk before the IEND chunk
    try {
        //change v2 format to v3
        const v3Data = JSON.parse(data);
        v3Data.spec = 'chara_card_v3';
        v3Data.spec_version = '3.0';

        const base64EncodedData = Buffer.from(JSON.stringify(v3Data), 'utf8').toString('base64');
        chunks.splice(-1, 0, PNGtext.encode('ccv3', base64EncodedData));
    } catch (error) {
        // Ignore errors when adding v3 chunk
    }

    const encoded = encode(chunks);
    return Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
};

/**
 * Reads Character metadata from a PNG image buffer.
 * Supports both V2 (chara) and V3 (ccv3). V3 (ccv3) takes precedence.
 * @param {Buffer} image PNG image buffer
 * @returns {string} Character data
 */
export const read = (image) => {
    const chunks = extract(image);

    const textChunks = chunks.filter((chunk) => chunk.name === 'tEXt').map((chunk) => textChunk(chunk.data));

    if (textChunks.length === 0) {
        console.error('PNG metadata does not contain any text chunks.');
        throw new Error('No PNG metadata.');
    }

    const ccv3Index = textChunks.findIndex((chunk) => chunk.keyword === 'ccv3');

    if (ccv3Index > -1) {
        return Buffer.from(textChunks[ccv3Index].text.toString('latin1'), 'base64').toString('utf8');
    }

    const charaIndex = textChunks.findIndex((chunk) => chunk.keyword === 'chara');

    if (charaIndex > -1) {
        return Buffer.from(textChunks[charaIndex].text.toString('latin1'), 'base64').toString('utf8');
    }

    console.error('PNG metadata does not contain any character data.');
    throw new Error('No PNG metadata.');
};

/**
 * Parses a card image and returns the character metadata.
 * @param {string} cardUrl Path to the card image
 * @param {string} format File format
 * @returns {Promise<string>} Character data
 */
export const parse = async (cardUrl, format) => {
    let fileFormat = format === undefined ? 'png' : format;

    switch (fileFormat) {
        case 'png': {
            const buffer = fs.readFileSync(cardUrl);
            return read(buffer);
        }
    }

    throw new Error('Unsupported format');
};

