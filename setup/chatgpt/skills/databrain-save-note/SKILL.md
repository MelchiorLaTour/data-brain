---
name: databrain-save-note
description: Save a note or idea with DataBrain ("save a note", "remember this", "write this down"); never as a file.
---
<!-- databrain-managed-skill: databrain-save-note (added by the DataBrain for ChatGPT installer; the installer replaces it and the uninstaller removes it) -->

# Save a note with DataBrain

1. Ask the user where to save it, in plain words: DataBrain's notes folder (name the approved folder, for example Documents) or another folder they name. Skip the question only if they already named a folder.
2. Call `databrain_capture` with the note's title, its text and that folder. Do not write the note with a file tool or in this chat's working folder: a file written there is not in DataBrain.
3. Tell the user the full place it was saved, from the "Saved to:" line of the result.

If `databrain_capture` is not available in this chat, say so and ask the user what to do instead. Do not quietly write a file.
