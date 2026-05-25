import re

PATTERNS = {
    "email": re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'),
    "phone": re.compile(r'(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}'),
    "date": re.compile(r'\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})\b'),
    "ssn": re.compile(r'\b\d{3}-\d{2}-\d{4}\b'),
    "address": re.compile(
        r'\b\d{1,5}\s+(?:[A-Z][a-z]+\s?){1,3}'
        r'(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Ct|Court|Way|Pl|Place)\b',
        re.IGNORECASE
    ),
    "name": re.compile(
        r'\b(?:Mr|Mrs|Ms|Dr|Prof)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b'
    ),
    "company": re.compile(
        r'\b[A-Z][a-zA-Z&\s]{2,30}(?:Inc|LLC|Ltd|Corp|Co|Company|Group|Industries|Engineering)\b',
        re.IGNORECASE
    ),
}


def scan_pii(text):
    """Return list of PII category strings found in text."""
    flags = []
    for category, pattern in PATTERNS.items():
        if pattern.search(text):
            flags.append(category)
    return flags
