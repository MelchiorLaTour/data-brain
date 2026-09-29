// Invoked by the local MCP server with `osascript -l JavaScript`.
// A native Open panel makes folder selection an explicit user action in the setup chat.
// This only returns selected paths; every caller must still enforce the recorded grant.
ObjC.import('AppKit');
ObjC.import('Foundation');

function run(argv) {
  var mode = argv.length ? ObjC.unwrap(argv[0]) : 'sources';
  if (mode !== 'sources' && mode !== 'destination-parent' && mode !== 'existing-databrain' && mode !== 'capture-destination' && mode !== 'setup-consent') {
    throw new Error('Unsupported folder selection mode.');
  }

  if (mode === 'setup-consent') {
    var details = argv.length > 1 ? JSON.parse(ObjC.unwrap(argv[1])) : {};
    if (typeof details.destination !== 'string' || !Array.isArray(details.roots) || !details.roots.length) {
      throw new Error('The setup approval details are incomplete.');
    }
    var approval = $.NSAlert.alloc.init;
    approval.setMessageText($('Approve DataBrain setup access'));
    approval.setInformativeText($(
      'Approval: ' + (details.action || 'initial setup') + '\n\nDataBrain will read eligible files only inside these folders:\n' +
      details.roots.join('\n') +
      '\n\nIt will create and write generated index files only here:\n' + details.destination +
      '\n\nSetup will run locally without changing originals or uploading the corpus. File and folder names and any excerpt deliberately returned for an answer may enter your ChatGPT conversation. Approve this exact scope?'
    ));
    approval.addButtonWithTitle($('Approve setup'));
    approval.addButtonWithTitle($('Cancel'));
    var consent = approval.runModal();
    return JSON.stringify({ approved: consent === $.NSAlertFirstButtonReturn });
  }

  var panel = $.NSOpenPanel.openPanel;
  panel.setCanChooseFiles(false);
  panel.setCanChooseDirectories(true);
  panel.setResolvesAliases(true);
  panel.setShowsHiddenFiles(false);
  panel.setAllowsMultipleSelection(mode === 'sources');
  panel.setCanCreateDirectories(false);
  var startingFolder = mode === 'sources' || mode === 'capture-destination' || mode === 'destination-parent'
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
  } else if (mode === 'existing-databrain') {
    panel.setTitle($('Choose an existing DataBrain folder'));
    panel.setMessage($('Select the DataBrain folder itself. DataBrain will verify its saved source folders before asking you to reconnect.'));
    panel.setPrompt($('Connect this brain'));
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
