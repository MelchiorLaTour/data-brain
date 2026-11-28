# DataBrain for the Claude app (Mac)

## [Install guide (PDF): DataBrain-install-guide.pdf](DataBrain-install-guide.pdf)

## [Click here to download databrain.mcpb](https://github.com/MelchiorLaTour/data-brain/releases/latest/download/databrain.mcpb)

It downloads straight to your Downloads folder.

Clicking the file name in the list above only opens a GitHub preview page. Use the link in this heading instead.

Tested on one Mac.

## Download for Claude Desktop (macOS)

**What DataBrain will not read:**

- Folders named `Resources/Sensitive`, `.git`, `node_modules`, `.obsidian`, `.ssh`, `.gnupg` and `.aws`, and any file that is not `.md`, `.txt`, `.pdf`, `.docx`, `.doc`, `.pages` or `.rtf`.
- Names are checked first, then text is checked on your Mac. Nothing is sent.
- Anything that looks private is held back until you say it is fine: taxes, bank, ID, medical, payslips, passwords, keys, contracts, in English and French, and any text with an IBAN, card number, social security number or private key.
- Scanned images such as `IMG_2231.jpg` are not checked.

**Do this:**

1 → Download **[databrain.mcpb](https://github.com/MelchiorLaTour/data-brain/releases/latest/download/databrain.mcpb)**.  
2 → Open **Claude → Settings… → Extensions**. (**Extensions** is in the left list, under **This computer**.)  
3 → Click **Advanced settings**.  
4 → Click **Install extension**. (Bottom of the page, under **Extension developer**.)  
5 → In the window that opens, click **databrain.mcpb**, then click **Open** at the bottom right. (It is in **Downloads**, in the left list. If your Mac added a number to the name, such as **databrain (1).mcpb**, click that one. If the next page says **Update** instead of **Install**, DataBrain was installed before. Uninstalling does not clear its saved folder list, so check that list in step 7 either way.)  
6 → Click **Install**. (The **Configure DataBrain** window opens next.)  
7 → Click **Add directory**, then the **folder icon**, and pick **Desktop**. Do it again for **Documents**, then **Downloads**. Nothing gets moved. Add one more directory for every other top-level folder you want searched (see footnote 1). These are all the folders your DataBrain can read. Sensitive information is held back and left untouched during setup. (Under **Folders DataBrain can read**, click **Add directory**. An empty row appears. Click the **folder icon** at the right end of that row. A Mac window opens. On its left, under **Favorites**, click **Desktop**, then click **Open** at the bottom right. Do the same with **Documents**, then **Downloads**. A folder is not in the list? Click the house icon with your name, double-click the folder, then click **Open**. Folders from an earlier install can still be listed, even after you uninstalled: remove any folder you do not want with its **X**. If you close the window by mistake: **Claude → Settings… → Extensions → DataBrain → Configure**.)  
This section should look somewhat like this:  
![The Configure DataBrain window. Under Folders DataBrain can read there are four rows: /Applications, /Users/User/Downloads, /Users/User/Desktop and /Users/User/Documents, each with a folder icon and an X, then an Add directory button, and Cancel and Save at the bottom. Your own user name appears instead of User.](configure-example.png)  
8 → Click **Save**. Then click the **Disabled** switch so it reads **Enabled**, and close the window with the **X** at the top right. (Click Save first: once the switch reads **Enabled**, there is no Save button to click.)  
9 → Check that DataBrain loaded. Close Settings completely, then open **Claude → Settings… → Extensions** again: **DataBrain** should be listed. Then open a new chat, click the **+** sign in the message box, click **Connectors**, and check that **DataBrain** is switched on. (You may need to scroll through your connectors.)  
10 → In a new chat, send this message: `Set up my DataBrain` (Claude shows you the folders DataBrain will read, in the chat. Check each one, then say **yes**. If a folder is wrong, say **no**, open **Claude → Settings… → Extensions → DataBrain → Configure**, remove it with its X, then send the message again. Claude may list files that look private and ask which are fine to index. If you are not sure, say **none**. When Claude asks to use DataBrain, we recommend **Always allow**: people approve almost every permission prompt anyway, [Anthropic found 93% of prompts are approved](https://www.anthropic.com/engineering/claude-code-auto-mode).)  
11 → When your Mac asks to let Claude access your Desktop or Documents folder, click **OK** (or **Allow**). (It can appear while Claude sets up. Documents, Desktop, Downloads, iCloud Drive, and external drives each ask once.)  
12 → When Claude says DataBrain is set up, tell Claude how to use it: open **Claude → Settings…**, click **Account** in the left list, and find the big text box named **Instructions for Claude** at the bottom of the **Profile** section. If the box already has text, keep all unrelated instructions. Replace any older DataBrain instruction with this line; if none is present, click at the end of the text, press **Return** twice, then paste it. If the box is empty, just paste it:  
`For ANY question about me (I, my, me, my life, work, hobbies, plans, or anything I keep or wrote), call databrain_search FIRST, even when general knowledge could answer it; general knowledge is not "memory". Start the answer with "From your files:" and where it comes from; if the answer does not come from DataBrain, start with "From general knowledge:". If DataBrain finds nothing, say so before falling back.`  
Then open a **new chat** and send the question DataBrain gave you.

**Footnote 1: which folders to add.** *For people who know computers:* adding a directory gives DataBrain read access to that folder and everything under it, including all subfolders. Add the top-level (parent) folders you want searched, such as the ones in your Finder **Favorites** list: **Desktop**, **Documents**, **Downloads**. You do not need to add their subfolders. Do not add your whole home folder: DataBrain refuses it. *Like you are five:* a folder is a box. A small box holds a few papers. A big box holds lots of little boxes. If you pick a big box, DataBrain looks inside all the little boxes in it too, so you do not have to pick each little box. But a big box like **Documents** has everything in it, even papers you may not want. If you only want one little box, pick just that one.

That's all. You can delete the downloaded file now. It is in your **Downloads** folder. DataBrain lives in your home folder: **Finder → Go → Home**.

To remove DataBrain: **Claude → Settings… → Extensions**, then on the **DataBrain** row click the **⋯** button (to the right of **Configure**) and click **Uninstall** (red). Your own files are never touched. DataBrain's folder stays on your Mac, in your home folder (**Finder → Go → Home**), named **DataBrain**, or **DataBrain 2** and so on. It holds copies of the text DataBrain read, so drag it to the Trash if you want that gone. Same steps with copy buttons: [app guide](databrain-app-guide.html).

Files kept in iCloud, OneDrive, Google Drive and Dropbox have not been tested yet. The terminal route for Claude Code is in [INSTALL.md](../../Terminal%20version%20%28recommended%29/macOS/INSTALL.md); test status is in the [acceptance ledger](../../Terminal%20version%20%28recommended%29/macOS/setup/ACCEPTANCE.md).

## If DataBrain stops working

After a restart, an update or a folder problem, send Claude `Run DataBrain repair`. If a folder was replaced
(restored from a backup, moved by iCloud), send `Re-approve my folder <name> in DataBrain`. Repair fixes what is
safe to fix, runs the install checks and reports what is still wrong. It never deletes, renames or moves your
files or the DataBrain folder, and never adds a folder. Without Claude: turn the extension on in
Claude → Settings… → Extensions → DataBrain, allow the folders in System Settings → Privacy & Security →
Files & Folders, or install the file again and pick your folders again (the existing brain is reused;
tested with the extension and its settings removed). Menu names were not re-checked on a Mac for this version.
