' AI看板管理器 静默启动 (无控制台窗口)
' 双击或开机自启时调用, 优先用打包的 manager.exe, 否则用 pythonw
Set fso = CreateObject("Scripting.FileSystemObject")
strDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = strDir

If fso.FileExists(strDir & "\manager.exe") Then
    WshShell.Run """" & strDir & "\manager.exe""", 0, False
Else
    ' pythonw 不弹黑窗; 优先 pythonw(系统默认 Python, 依赖已装), 退回 py launcher
    On Error Resume Next
    WshShell.Run "pythonw """ & strDir & "\manager.py""", 0, False
    If Err.Number <> 0 Then
        Err.Clear
        WshShell.Run "py -3 """ & strDir & "\manager.py""", 0, False
    End If
    On Error GoTo 0
End If
