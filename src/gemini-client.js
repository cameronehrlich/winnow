import { GoogleGenAI } from '@google/genai';

let client;

export function getGeminiClient() {
  if (!client) {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) throw new Error('GOOGLE_CLOUD_PROJECT environment variable is required');
    client = new GoogleGenAI({
      vertexai: true,
      project,
      location: process.env.GOOGLE_CLOUD_LOCATION || 'global',
    });
  }
  return client;
}
