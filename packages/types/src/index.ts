/**
 * Known fields from the Retraction Watch CSV database.
 * All fields are optional as the CSV schema may change.
 * @see https://gitlab.com/crossref/retraction-watch-data
 */
export interface RetractionWatchFields {
  /** Type of notice: "Retraction", "Correction", "Expression of Concern", etc. */
  RetractionNature?: string;
  /** Reason(s) for the retraction, semicolon-separated */
  Reason?: string;
  /** Title of the original paper */
  Title?: string;
  /** Type of article: "Research Article", "Review", etc. */
  ArticleType?: string;
  /** Date the retraction notice was published (YYYY-MM-DD) */
  RetractionDate?: string;
  /** Additional notes about the retraction */
  Notes?: string;
  /** DOI of the retraction notice */
  RetractionDOI?: string;
  /** DOI of the original paper */
  OriginalPaperDOI?: string;
  /** PubMed ID of the retraction notice */
  RetractionPubMedID?: string;
  /** PubMed ID of the original paper */
  OriginalPaperPubMedID?: string;
  /** Journal name */
  Journal?: string;
  /** Publisher name */
  Publisher?: string;
  /** Country of the institution */
  Country?: string;
  /** Author names */
  Author?: string;
  /** Institution name */
  Institution?: string;
  /** Allow additional unknown fields from CSV */
  [key: string]: string | undefined;
}

export interface RetractionRecord {
  recordId: number;
  /** Raw fields from Retraction Watch CSV */
  raw: RetractionWatchFields;
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

/** Extension settings stored in chrome.storage.sync */
export interface ExtensionSettings {
  remoteEnabled: boolean;
}

/** Rate limit info returned from API or background script */
export interface RateLimitInfo {
  type: 'status' | 'override';
  retryAt: number;
}

