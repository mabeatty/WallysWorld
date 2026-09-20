"use client";

import { useState } from "react";

export default function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <textarea className="code" readOnly value={value} onFocus={(e) => e.currentTarget.select()} aria-label="Connection code" />
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? "Copied" : "Copy connection code"}
        </button>
      </div>
    </div>
  );
}
