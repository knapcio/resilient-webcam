# Releasing

Only a maintainer with npm and GitHub access should perform a release.

1. Confirm `CHANGELOG.md` has the intended version and date.
2. Confirm `package.json` has the same version.
3. Run `npm ci`, then `npm run check`.
4. Inspect `npm pack --dry-run`; only the allowlisted package files should appear.
5. Confirm the package name and authentication with `npm view resilient-webcam`
   and `npm whoami`. The first publish may require choosing another available
   package name and updating repository metadata.
6. Commit the release metadata and create an annotated `vX.Y.Z` tag.
7. Run `npm publish --access public` from a clean checkout.
8. Push the commit and tag, then create GitHub release notes from the matching
   changelog section.

`prepublishOnly` runs the full validation suite. Do not bypass it. If you
later configure npm trusted publishing in GitHub Actions, provenance can be
enabled in that release workflow; it is intentionally not forced for a manual
publish.

If publication fails after a tag is pushed, do not reuse the version for
different contents. Fix forward with a new patch version.
