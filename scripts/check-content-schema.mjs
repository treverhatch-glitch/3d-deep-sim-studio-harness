#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../harness/event.mjs';

const readJson = (file, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return d;
    console.error(`Error reading or parsing JSON file ${file}: ${e.message}`);
    return null;
  }
};

function validate(data, schema, pathPrefix = '') {
  const errors = [];
  const type = schema.type === 'integer' ? 'number' : schema.type;
  if (type && typeof data !== type) {
    errors.push(`${pathPrefix}: type should be ${schema.type}, but got ${typeof data}`);
    return errors;
  }
  if (schema.type === 'integer' && !Number.isInteger(data)) {
    errors.push(`${pathPrefix}: type should be integer, but got float`);
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${pathPrefix}: value ${data} is not in enum ${schema.enum.join(', ')}`);
  }
  if (schema.minimum !== undefined && data < schema.minimum) {
    errors.push(`${pathPrefix}: value ${data} is less than minimum ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && data > schema.maximum) {
    errors.push(`${pathPrefix}: value ${data} is greater than maximum ${schema.maximum}`);
  }

  if (schema.type === 'object') {
    if (schema.required) {
      for (const prop of schema.required) {
        if (!(prop in data)) {
          errors.push(`${pathPrefix}: missing required property "${prop}"`);
        }
      }
    }
    if (schema.properties) {
      for (const prop in data) {
        if (schema.properties[prop]) {
          errors.push(...validate(data[prop], schema.properties[prop], `${pathPrefix}.${prop}`));
        }
      }
    }
  }

  if (schema.type === 'array') {
    if (!Array.isArray(data)) {
      errors.push(`${pathPrefix}: type should be array, but got ${typeof data}`);
    } else if (schema.items) {
      data.forEach((item, i) => {
        errors.push(...validate(item, schema.items, `${pathPrefix}[${i}]`));
      });
    }
  }
  return errors;
}

function main() {
  const cartridge = readJson(path.join(REPO_ROOT, 'studio', 'game.json'))?.cartridge || process.env.STUDIO_CARTRIDGE || readJson(path.join(REPO_ROOT, 'studio', 'gates.json'))?.cartridge;
  const contentDir = cartridge ? path.join(REPO_ROOT, 'cartridges', cartridge, 'content') : null;
  if (!contentDir || !fs.existsSync(contentDir)) {
    console.log('PASS: no content folder yet (cartridges/<game>/content/), nothing to check.');
    return 0;
  }

  const bible = readJson(path.join(REPO_ROOT, 'studio', 'bible', 'bible.json'));
  if (!bible) {
    console.error('FAIL: content exists but studio/bible/bible.json is missing, so no layer can be checked.');
    return 1;
  }

  const keptLayers = new Set();
  for (const layerId in bible.layers) {
    if (bible.layers[layerId].answer === 'yes') {
      keptLayers.add(layerId);
    }
  }

  const contentFiles = fs.readdirSync(contentDir).filter(f => f.endsWith('.json'));
  let totalErrors = 0;
  const newestOpenPhase = Math.max(bible.phase.open, ...(bible.phase.floors || []).map(f => f.n));

  for (const file of contentFiles) {
    const layerId = path.basename(file, '.json');
    if (!keptLayers.has(layerId)) {
      console.error(`FAIL: ${file} corresponds to layer "${layerId}" which is not 'yes' in the bible.`);
      totalErrors++;
      continue;
    }

    const contentPath = path.join(contentDir, file);
    const content = readJson(contentPath);
    if (!Array.isArray(content)) {
      console.error(`FAIL: ${file} must contain a JSON array.`);
      totalErrors++;
      continue;
    }

    const schemaPath = path.join(REPO_ROOT, 'studio', 'bible', 'schemas', `${layerId}.schema.json`);
    const schema = readJson(schemaPath);

    for (const [i, item] of content.entries()) {
      if (!item || typeof item.id !== 'string') {
        console.error(`FAIL: ${file} item[${i}] is missing an "id" property.`);
        totalErrors++;
        continue;
      }
      if (typeof item.phase !== 'number' || !Number.isInteger(item.phase)) {
        console.error(`FAIL: ${file} id="${item.id}" is missing an integer "phase" property.`);
        totalErrors++;
      } else if (item.phase > newestOpenPhase) {
        console.warn(`WARN: ${file} id="${item.id}" is for phase ${item.phase}, which is not open yet (newest is ${newestOpenPhase}).`);
      }

      if (schema) {
        const errors = validate(item, schema);
        if (errors.length > 0) {
          console.error(`FAIL: ${file} id="${item.id}" failed schema validation:`);
          errors.forEach(e => console.error(`  - ${e}`));
          totalErrors++;
        }
      }
    }
  }

  if (totalErrors > 0) {
    console.error(`\nFound ${totalErrors} content error(s).`);
    return 1;
  }

  console.log('PASS: All content files are valid.');
  return 0;
}

process.exit(main());
