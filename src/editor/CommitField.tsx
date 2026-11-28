import { type InputHTMLAttributes, useState } from 'react';

/**
 * A text field that takes what is typed on Enter or on leaving it. It keeps the focus; what is refused goes back to the
 * stored value; a stored value changed elsewhere (undo, say) shows at once.
 */
export function CommitField({ value, onCommit, ...rest }: { value: string; onCommit(text: string): boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value);
  const [stored, setStored] = useState(value);
  if (stored !== value) {
    // adjusting to a new stored value while rendering, as React advises, rather than in an effect
    setStored(value);
    setText(value);
  }
  const take = () => {
    if (text !== value && !onCommit(text)) setText(value);
  };
  return <input {...rest} value={text} onChange={event => setText(event.target.value)} onBlur={take} onKeyDown={event => event.key === 'Enter' && take()} />;
}
