import { GoogleGenAI } from '@google/genai';
import { readFileSync, statSync } from 'node:fs';

let client;

export function getVertexClientOptions() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT environment variable is required');

  const options = {
    vertexai: true,
    project,
    location: process.env.GOOGLE_CLOUD_LOCATION || 'global',
  };
  const keyPath = process.env.WINNOW_VERTEX_API_KEY_FILE;
  if (keyPath) {
    if (statSync(keyPath).mode & 0o077) {
      throw new Error('WINNOW_VERTEX_API_KEY_FILE must not be readable by other users');
    }
    const apiKey = readFileSync(keyPath, 'utf8').trim();
    if (!apiKey) throw new Error('WINNOW_VERTEX_API_KEY_FILE is empty');
    options.apiKey = apiKey;
  }
  return options;
}

export function getGeminiClient() {
  if (!client) {
    client = new GoogleGenAI(getVertexClientOptions());
  }
  return client;
}
