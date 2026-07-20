export type TextbookEntry = {
  index?: number;
  label?: string;
  env?: string;
  number_components?: string[];
  context?: Record<string, string>;
  content?: string;
  dependencies?: string[];
  proof?: string | null;
};

export type TextbookEntryPatch = {
  content?: string;
  content_replacements?: {
    from: string;
    to: string;
    expected_matches: number;
  }[];
  append_content?: string;
  dependencies?: string[];
  proof?: string | null;
};

type TextbookOverlayDate =
  | { erratum_date: string; review_date?: never }
  | { review_date: string; erratum_date?: never };

export type TextbookOverlayOperation = TextbookOverlayDate & (
  | {
      operation: 'merge';
      textbook_json: string;
      label: string;
      patch: TextbookEntryPatch;
    }
  | {
      operation: 'append';
      textbook_json: string;
      label: string;
      entry: TextbookEntry & { label: string };
    }
);

export type TextbookOverlayDocument = {
  schema: 'openga-review.textbook-overlay.v1';
  source: {
    kind: 'official_errata' | 'openga_clarification';
    title: string;
    url: string;
  };
  operations: TextbookOverlayOperation[];
};

export type LeanDeclaration = {
  kind: string;
  name: string;
  fullName: string;
  docstring: string | null;
  signature: string;
  sourceFile?: string;
};

export type LeanParsedCommand = {
  kind: string;
  namespaces: string[];
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
};
