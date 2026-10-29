# Archive lookup across all states (plan 038 T06)

Read-only survey. No uploads were performed and no cookies were printed.

## Question

Can biliup enumerate **all** archive states (in review, published, rejected) with title,
time and duration, so a transfer retry can prove "no draft exists" before re-uploading?

## What was checked

- `biliup list --help` on the locally installed CLI.
- The stream_gears extension strings for the filter names.

## Observation

The CLI exposes three explicit filters:

```
biliup list --help
--is-pubing              只包含进行中的视频
--pubed                  只包含已通过的视频
--not-pubed              只包含未通过的视频
-f, --from-page <FROM_PAGE>  从第几页开始获取 [default: 1]
-m, --max-pages <MAX_PAGES>  最大获取页数
```

The extension carries the same three filter names (`is_pubing`, `pubed`, `not_pubed`), which
indicates they are separate server-side filters rather than one unfiltered listing.

## Conclusion

- All three states can be queried individually, so a finder can run the three filters (plus
  pagination) and union the results.
- There is no single "everything" flag observed; the finder must issue three queries.
- This was verified at the CLI/extension level only. A real logged-in listing was **not** run
  in this survey because no login file is present on this machine.
- Consequence for the plan: `findRecentArchive` must query all three filters and treat any
  failed query as "unknown" (never as "no draft"). The real-response fixture is deferred to
  T14, where a human-authorized upload provides a logged-in session.
