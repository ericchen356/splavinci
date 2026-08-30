'use client';

/**
 * The pieces both create forms are built out of.
 *
 * Extracted from app/page.tsx when a second way of making a capture arrived:
 * generating one from photos and uploading one you already have ask for
 * different things, but they ask in the same voice — a numbered step, a
 * dropzone that is really a file input, a tile per attached file, a labelled
 * control that owns its own error wiring. Those four are here so the two forms
 * cannot drift apart in the details that make a form usable.
 *
 * Everything in this file is presentation. What is valid, and what happens on
 * submit, belongs to whichever form is using it.
 */

import { useId, useRef, useState } from 'react';

import { Icon } from '@/components/Icon';
import { formatBytes } from '@/app/api/renders/limits';

/* A numbered step. No slot for a caption beside the title: the ones that were
   there explained how the pipeline works, which is not a thing anyone filling
   in this form needs to know. What the field accepts stays, on the control. */
export function Step({
  n,
  title,
  optional,
  children,
}: {
  n: number;
  title: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="home-step">
      <div className="home-step__head">
        <span className="home-step__n" aria-hidden="true">
          {n}
        </span>
        <span className="home-step__title">
          {title}
          {optional && <span className="home-step__optional">optional</span>}
        </span>
      </div>
      <div className="home-step__body">{children}</div>
    </section>
  );
}

/**
 * A real file input with a drop target draped over it.
 *
 * The input is the control: it is what Tab reaches, what Enter opens, and what
 * the label names. Dragging is an accelerator layered on top, never the only
 * route in — WCAG 2.2 requires a single-pointer alternative for any drag the
 * page invents, and a div with an onDrop handler is exactly that trap.
 */
export function DropZone({
  label,
  sublabel,
  accept,
  multiple,
  compact,
  invalid,
  error,
  onFiles,
}: {
  label: string;
  sublabel?: string;
  /** Filters the picker only. A drop bypasses it, so `validateUpload` is the check. */
  accept: string;
  multiple?: boolean;
  compact?: boolean;
  invalid?: boolean;
  error?: string | null;
  onFiles: (files: File[]) => void;
}) {
  const inputId = useId();
  const labelId = `${inputId}-label`;
  const subId = `${inputId}-sub`;
  const errorId = `${inputId}-error`;
  const [over, setOver] = useState(false);
  /* dragenter/dragleave fire for every child the pointer crosses; a depth count
     is the only way to know the pointer actually left the zone. */
  const depth = useRef(0);

  return (
    <>
      <label
        className="home-drop"
        htmlFor={inputId}
        data-over={over || undefined}
        data-invalid={invalid || undefined}
        data-compact={compact || undefined}
        onDragEnter={(event) => {
          event.preventDefault();
          depth.current += 1;
          setOver(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          depth.current = 0;
          setOver(false);
          const dropped = Array.from(event.dataTransfer.files);
          if (dropped.length > 0) onFiles(multiple ? dropped : dropped.slice(0, 1));
        }}
      >
        {/* Named by the visible text rather than by the wrapping <label>: a file
            input's implicit label is resolved inconsistently, and the one thing
            that must never be in doubt is what this control is called. */}
        <input
          id={inputId}
          className="visually-hidden"
          type="file"
          accept={accept}
          multiple={multiple}
          aria-labelledby={labelId}
          aria-invalid={invalid || undefined}
          aria-describedby={[sublabel ? subId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined}
          onChange={(event) => {
            const chosen = Array.from(event.target.files ?? []);
            if (chosen.length > 0) onFiles(chosen);
            // Cleared so re-picking the same file after a remove still fires.
            event.target.value = '';
          }}
        />
        <span className="home-drop__label" id={labelId}>
          {label}
        </span>
        {sublabel && (
          <span className="home-drop__sub" id={subId}>
            {sublabel}
          </span>
        )}
      </label>
      {error && (
        <p className="home-field__error" id={errorId} role="alert">
          <Icon name="error" /> {error}
        </p>
      )}
    </>
  );
}

/**
 * The two things a tile shows. Not `File`, because a file that has already
 * been uploaded is a name and a size on the server, not a handle in this tab.
 */
export type FileFacts = { name: string; size: number };

/**
 * One attached file: what it is called, how big it is, and a way to take it
 * back. Omitting `onRemove` drops the button rather than leaving a dead one —
 * an upload in flight is not a thing you can un-attach.
 */
export function FileTile({
  file,
  onRemove,
  note,
}: {
  file: FileFacts;
  onRemove?: () => void;
  /** A short status beside the size — "uploading", "measured", a count. */
  note?: string;
}) {
  return (
    <div className="home-file">
      <span className="home-file__name" title={file.name}>
        {file.name}
      </span>
      <span className="home-file__size">
        {formatBytes(file.size)}
        {note && <span className="home-file__note"> · {note}</span>}
      </span>
      {onRemove && (
        <button
          type="button"
          className="home-file__remove"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * Label, hint, control, error — wired together by id.
 *
 * A render prop rather than a wrapper so the input keeps its own type and
 * value binding while this owns the parts that must agree: `id` on the label,
 * `aria-describedby` pointing at both the hint and the error, `aria-invalid`
 * when there is one.
 */
export function Field({
  label,
  hint,
  optional,
  error,
  onBlur,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  error: string | null;
  onBlur: () => void;
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': true | undefined;
    onBlur: () => void;
  }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="home-field">
      <label className="home-field__label" htmlFor={id}>
        {label}
        {optional && <span className="home-field__optional">optional</span>}
      </label>
      {children({
        id,
        'aria-describedby': described || undefined,
        'aria-invalid': error ? true : undefined,
        onBlur,
      })}
      {hint && (
        <p className="home-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="home-field__error" id={errorId} role="alert">
          <Icon name="error" /> {error}
        </p>
      )}
    </div>
  );
}
