// Invoked by the local MCP server with `osascript -l JavaScript`.
// A native Open panel makes folder selection an explicit user action in the setup chat.
// This only returns selected paths; every caller must still enforce the recorded grant.
ObjC.import('AppKit');
ObjC.import('Foundation');

function run(argv) {
  var mode = argv.length ? ObjC.unwrap(argv[0]) : 'sources';
  if (mode !== 'sources' && mode !== 'destination-parent' && mode !== 'capture-destination') {
    throw new Error('Unsupported folder selection mode.');
  }

  var panel = $.NSOpenPanel.openPanel;
  panel.setCanChooseFiles(false);
  panel.setCanChooseDirectories(true);
  panel.setResolvesAliases(true);
  panel.setShowsHiddenFiles(false);
  panel.setAllowsMultipleSelection(mode === 'sources');
  panel.setCanCreateDirectories(false);
  var startingFolder = mode === 'sources' || mode === 'capture-destination'
    ? $.NSFileManager.defaultManager.URLsForDirectory_inDomains(
        $.NSDesktopDirectory, $.NSUserDomainMask
      ).firstObject
    : $.NSFileManager.defaultManager.homeDirectoryForCurrentUser;
  panel.setDirectoryURL(startingFolder);

  if (mode === 'sources') {
    panel.setTitle($('Choose source folders for DataBrain'));
    panel.setMessage($('Select every folder you want DataBrain to search. The originals stay where they are.'));
    panel.setPrompt($('Use selected folders'));
  } else if (mode === 'destination-parent') {
    panel.setTitle($('Choose where to create DataBrain'));
    panel.setMessage($('Choose Desktop to create the default Desktop/DataBrain folder.'));
    panel.setPrompt($('Choose this location'));
  } else {
    panel.setTitle($('Choose where to save this new DataBrain note'));
    panel.setMessage($('Choose one folder inside a source folder you already approved. DataBrain will create a new file and will not replace an existing file.'));
    panel.setPrompt($('Save in this folder'));
  }

  var response = panel.runModal();
  if (response !== $.NSModalResponseOK) return JSON.stringify({ cancelled: true });

  var urls = ObjC.deepUnwrap(panel.URLs);
  var paths = urls.map(function (url) {
    return ObjC.unwrap(url.path);
  });
  return JSON.stringify({ cancelled: false, paths: paths });
}
