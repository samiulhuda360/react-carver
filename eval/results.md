# Evaluation results

12 labelled sample pages in `samples/`, labels in `eval/labels.json`. Run with `npm run eval`.

## Output correctness: react-carver vs naive find-and-replace

| Check | react-carver | Naive find-and-replace |
| --- | --- | --- |
| Pages that pass all five checks | 12/12 (100.0%) | 0/12 (0.0%) |
| Compiles (esbuild) | 12/12 | 10/12 |
| Type-checks (TypeScript strict) | 12/12 | 1/12 |
| Renders with no React warnings | 12/12 | 1/12 |
| Same text as the original | 12/12 | 1/12 |
| Same element tree as the original | 12/12 | 1/12 |

## Structure and naming

| Measure | Result |
| --- | --- |
| Labelled sections found | 39/39 (100.0%) |
| Repeated blocks: recall (labelled runs found) | 19/19 (100.0%) |
| Repeated blocks: precision (found runs that were labelled) | 19/19 (100.0%) |
| Component names a reviewer accepts, rules only | 53/58 (91.4%) |
| Component names a reviewer accepts, AI renames every component | 43/58 (74.1%) |
| Component names a reviewer accepts, AI renames only weak names (default) | 53/58 (91.4%) |
| Props with a generic name (text2, cell3, label...), rules only | 24/76 (31.6%) |
| Props with a generic name, rules + AI | 8/76 (10.5%) |

## Per page

| Page | Pass | Components | Sections found | Repeated runs (matched/labelled/found) | Time |
| --- | --- | --- | --- | --- | --- |
| ridgeway-tours/index.html | yes | 11 | 6/6 | 4/4/4 | 2587 ms |
| pricing.html | yes | 9 | 5/5 | 2/2/2 | 603 ms |
| blog.html | yes | 9 | 4/4 | 2/2/2 | 456 ms |
| restaurant-menu.html | yes | 6 | 3/3 | 2/2/2 | 379 ms |
| contact-form.html | yes | 3 | 2/2 | 0/0/0 | 409 ms |
| data-table.html | yes | 3 | 1/1 | 1/1/1 | 344 ms |
| gallery.html | yes | 5 | 3/3 | 1/1/1 | 240 ms |
| docs-page.html | yes | 3 | 2/2 | 0/0/0 | 380 ms |
| event-landing.html | yes | 7 | 4/4 | 2/2/2 | 369 ms |
| team-page.html | yes | 4 | 2/2 | 1/1/1 | 254 ms |
| product-page.html | yes | 8 | 4/4 | 2/2/2 | 341 ms |
| dashboard.html | yes | 7 | 3/3 | 2/2/2 | 413 ms |
