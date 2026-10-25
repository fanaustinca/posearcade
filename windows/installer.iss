; Inno Setup script for Unbound. Built by build.ps1:
;   ISCC /DAppVersion=1.0.0 /DSrcDir=build\Unbound /DOutDir=dist installer.iss
; Per-user install (no admin prompt) into %LOCALAPPDATA%\Programs\Unbound.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{87F15B93-B07A-4677-B4C0-179D039E6424}
AppName=Unbound
AppVersion={#AppVersion}
AppVerName=Unbound {#AppVersion}
AppPublisher=Unbound
AppComments=Full-body motion games that track you with your webcam and GPU
DefaultDirName={localappdata}\Programs\Unbound
DefaultGroupName=Unbound
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=yes
DisableWelcomePage=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
SetupIconFile={#SrcDir}\unbound.ico
UninstallDisplayIcon={app}\Unbound.exe
UninstallDisplayName=Unbound
OutputDir={#OutDir}
OutputBaseFilename=Unbound-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
LZMANumBlockThreads=4
CloseApplications=yes
RestartApplications=no

[Messages]
WelcomeLabel2=This will install Unbound, full-body motion games played with your webcam.%n%nEverything it needs is included: the pose-tracking AI, CUDA for NVIDIA GPUs (RTX 3050 or better recommended) and a DirectX fallback for other GPUs. Nothing else to install.

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[InstallDelete]
; drop files from older versions before copying the new ones
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\rt"
Type: filesandordirs; Name: "{app}\models"
; a new version re-picks the GPU engine
Type: files; Name: "{localappdata}\Unbound\engine.json"

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Unbound"; Filename: "{app}\Unbound.exe"; IconFilename: "{app}\unbound.ico"
Name: "{autodesktop}\Unbound"; Filename: "{app}\Unbound.exe"; IconFilename: "{app}\unbound.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\Unbound.exe"; Description: "Play Unbound now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; compiled .pyc files, engine cache, logs and the game window's browser profile
Type: filesandordirs; Name: "{app}"
Type: filesandordirs; Name: "{localappdata}\Unbound"
