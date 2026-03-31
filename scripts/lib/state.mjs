import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_FILE = join(import.meta.dirname, '..', 'transcribe-state.json');

export function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
}

export function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getEpisodeState(state, slug) {
  return state[slug] || null;
}

export function setEpisodeState(state, slug, data) {
  state[slug] = { ...state[slug], ...data, updatedAt: new Date().toISOString() };
  saveState(state);
}
