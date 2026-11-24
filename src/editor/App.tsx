import { copy } from '../copy';

export function App() {
  return (
    <main>
      <title>{copy.title}</title>
      <label>
        {copy.upload} <input type="file" accept="application/pdf,.pdf" data-testid="upload" />
      </label>
      {/* ltr: the drawing never mirrors with the RTL page */}
      <div dir="ltr" data-testid="drawing" />
    </main>
  );
}
