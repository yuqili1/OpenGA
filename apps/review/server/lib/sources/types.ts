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
  dependencies?: string[];
  proof?: string | null;
};

export type TextbookOverlayOperation =
  | {
      operation: 'merge';
      textbook_json: string;
      label: string;
      erratum_date: string;
      patch: TextbookEntryPatch;
    }
  | {
      operation: 'append';
      textbook_json: string;
      label: string;
      erratum_date: string;
      entry: TextbookEntry & { label: string };
    };

export type TextbookOverlayDocument = {
  schema: 'openga-review.textbook-overlay.v1';
  source: {
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
