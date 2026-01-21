# Privacy Policy

**Last updated: January 21, 2026**

RetractCheck is a browser extension that checks research articles against the Retraction Watch database. This policy explains what data the extension accesses and how it is used.

## Data We Access

**DOI (Digital Object Identifier):** When you visit a research article page, the extension reads the page's metadata to extract the DOI. This DOI is sent to our API to check for retraction notices.

**Page URL and hostname:** Used to determine if the current site is a supported academic publisher.

## Data We Store Locally

The following data is stored in your browser's local storage:

- **User preferences:** Whether the extension is enabled or disabled
- **API response cache:** Cached retraction check results to reduce network requests (cleared after 12 hours)
- **Client ID:** A randomly generated identifier used solely for API rate limiting

This data never leaves your browser except as described below.

## Data We Send

When checking a DOI, the extension sends:

- The DOI being checked
- Your client ID (for rate limiting)

to our API server. We do not log or store DOIs or client IDs on our server.

## Data We Do NOT Collect

- Personal information (name, email, address)
- Browsing history
- Cookies or tracking data
- Any data from non-academic pages

## Third Parties

Retraction data is sourced from the [Retraction Watch database](https://retractionwatch.com/). We do not share any user data with third parties.

## Changes

If this policy changes, the updated version will be posted here with a new date.

## Contact

Questions? Open an issue at [github.com/gouthamindukuri/RetractCheck-Extension](https://github.com/gouthamindukuri/RetractCheck-Extension/issues).
