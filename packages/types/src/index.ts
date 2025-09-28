export interface RetractionRecord {
  recordId: number;
  raw: Record<string, string>;
  updatedAt: number;
}

export interface RetractionStatusResponse {
  doi: string;
  meta: {
    datasetVersion?: string;
    updatedAt?: string;
  };
  records: RetractionRecord[];
}

