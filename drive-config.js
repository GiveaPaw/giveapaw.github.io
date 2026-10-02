// Google Drive settings shared by the review builder and the review page.
// Fill these in after following REVIEW-BUILDER-SETUP.md. All three values are public client identifiers
// (they ship to every visitor); access is limited by the OAuth consent screen and the key restrictions.
//
//   apiKey   - Google Cloud API key restricted to the Drive API + Picker API and to this site's origin.
//              The review page uses it to read files that are shared as "anyone with the link".
//   clientId - OAuth 2.0 Web client ID. The builder uses it to sign the author in (scope: drive.file).
//   appId    - The Google Cloud project NUMBER (not the ID). The Picker needs it.
//   folderName - Drive folder that saved reviews go into (created on first save).

export const driveConfig = {
    apiKey: '',
    clientId: '',
    appId: '71300213332',
    folderName: 'Give a Paw Reviews',
};
