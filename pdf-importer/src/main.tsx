import '@fontsource/assistant';
import { createRoot } from 'react-dom/client';
import { App } from './editor/App';
import { COLOR } from './theme';

const { style } = document.documentElement;
for (const [name, value] of Object.entries(COLOR)) style.setProperty(`--c-${name}`, value);
style.color = 'var(--c-ink)';
style.fontFamily = 'Assistant, sans-serif';

createRoot(document.getElementById('root')!).render(<App />);
