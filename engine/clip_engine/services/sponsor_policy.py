"""Shared advertising boundary for discovery, review and boundary repair."""

SPONSOR_ALLOWED = (
    'The excerpt is substantive discussion, criticism, education, a product walkthrough or a software demo '
    'that is the main subject of the source, without evidence that it belongs to a sponsor read or ad segment. '
    'A creator demonstrating their own product is allowed. Brand names, first-person demo language, '
    'feature/price/performance comparisons, enthusiasm or a closing availability/link mention alone '
    'do not establish advertising or paid sponsorship. Do not require proof that the presenter is independent. '
    'A completed sponsor segment elsewhere does not make the following substantive topic sponsored.'
)
SPONSOR_EXCLUDED = (
    'The excerpt belongs to a sponsor read, paid endorsement, affiliate offer or a discrete advertising segment, '
    'or is a direct sales pitch without a substantive explanation or demonstration. '
    'Use concrete contextual evidence such as a sponsorship disclosure, affiliate commission/discount offer '
    'or an explicit ad break. A disclosure just outside the excerpt still applies to that ad segment; '
    'informative technical details inside a disclosed sponsor read do not make it eligible. '
    'Do not remove a disclosure to disguise an ad as independent discussion.'
)
SPONSOR_DISCOVERY_RULE = (
    '\nADVERTISING BOUNDARY: Exclude sponsor reads, paid promotions, affiliate pitches and advertising segments. '
    + SPONSOR_EXCLUDED + ' Eligible content: ' + SPONSOR_ALLOWED
    + ' Evaluate individual topic segments; do not blanket-reject a product-focused source as advertising.'
)
