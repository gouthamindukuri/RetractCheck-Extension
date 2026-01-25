/**
 * All fields from the Retraction Watch CSV database.
 * @see https://gitlab.com/crossref/retraction-watch-data
 */
export interface RetractionWatchFields {
  /** Unique identifier in the Retraction Watch database */
  'Record ID'?: string;
  /** Title of the original paper */
  Title?: string;
  /** Subject area(s), semicolon-separated */
  Subject?: string;
  /** Institution name(s) */
  Institution?: string;
  /** Journal name */
  Journal?: string;
  /** Publisher name */
  Publisher?: string;
  /** Country of the institution */
  Country?: string;
  /** Author names, semicolon-separated */
  Author?: string;
  /** Related URLs (Retraction Watch articles, etc.) */
  URLS?: string;
  /** Type of article: "Research Article", "Review", "Clinical Study", etc. */
  ArticleType?: string;
  /** Date the retraction notice was published */
  RetractionDate?: string;
  /** DOI of the retraction notice */
  RetractionDOI?: string;
  /** PubMed ID of the retraction notice */
  RetractionPubMedID?: string;
  /** Date the original paper was published */
  OriginalPaperDate?: string;
  /** DOI of the original paper */
  OriginalPaperDOI?: string;
  /** PubMed ID of the original paper */
  OriginalPaperPubMedID?: string;
  /** Type of notice: "Retraction", "Correction", "Expression of Concern", etc. */
  RetractionNature?: string;
  /** Reason(s) for the retraction, semicolon-separated */
  Reason?: string;
  /** Whether the paper is paywalled: "Yes" or "No" */
  Paywalled?: string;
  /** Additional notes about the retraction */
  Notes?: string;
}

export interface RetractionRecord {
  recordId: number;
  /** Fields from Retraction Watch CSV */
  raw: RetractionWatchFields;
}

export interface RetractionStatusResponse {
  doi: string;
  meta: {
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
