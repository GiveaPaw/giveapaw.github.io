// Firebase settings for live review sessions (follow-the-leader, laser pointer, live highlights).
// From Firebase console → Project settings → Your apps → Web app "Give a Paw" (see LIVE-SESSION-SETUP.md).
// These are public client identifiers; access is limited by the Realtime Database rules and Anonymous sign-in.
// While `databaseURL` is empty the page runs sessions in a same-browser demo mode (tabs of one browser only).

export const firebaseConfig = {
    apiKey: 'AIzaSyAAdztQNg1vPXilmUW2LTZHK8T23tfUVdQ',
    authDomain: 'give-a-paw.firebaseapp.com',
    databaseURL: 'https://give-a-paw-default-rtdb.firebaseio.com',
    projectId: 'give-a-paw',
    appId: '1:71300213332:web:b14838b1d14fa3286edbc1',
};
