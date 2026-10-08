import fs from 'node:fs';
import yaml from 'yaml';

export function loadAndroidConfig(defaultPath, savedPath) {
    const defaults = yaml.parse(fs.readFileSync(defaultPath, 'utf8'));
    if (!fs.existsSync(savedPath)) return defaults;
    const saved = yaml.parse(fs.readFileSync(savedPath, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid saved Android configuration');
    const merge = (base, values) => {
        for (const [key, value] of Object.entries(values)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
            if (value && typeof value === 'object' && !Array.isArray(value)
                && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) merge(base[key], value);
            else base[key] = value;
        }
        return base;
    };
    return merge(defaults, saved);
}
