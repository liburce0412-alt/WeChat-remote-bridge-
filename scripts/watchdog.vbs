Option Explicit

Dim fileSystem, shell, scriptDirectory, watchdogScript, command
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
watchdogScript = fileSystem.BuildPath(scriptDirectory, "watchdog.ps1")
command = "pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Chr(34) & watchdogScript & Chr(34)

' wscript.exe is a GUI process; window style 0 keeps the child console fully hidden.
shell.Run command, 0, True
