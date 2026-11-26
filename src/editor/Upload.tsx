import { copy } from '../copy';

export function Upload({ onFile }: { onFile(file: File): void }) {
  return (
    <label className="upload">
      {copy.upload}
      <input
        type="file"
        accept="application/pdf,.pdf"
        data-testid="upload"
        onChange={event => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = ''; // so that the same file can be chosen again
        }}
      />
    </label>
  );
}
