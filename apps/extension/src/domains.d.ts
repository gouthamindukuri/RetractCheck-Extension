interface DomainsLib {
  _allowedDomains: Record<string, string[]>;
  getDomainList(): string[];
  extractDomainsFromUrl(_url: string): string[];
  validate(_url: string): boolean;
}

declare const Domains: DomainsLib;
export default Domains;
