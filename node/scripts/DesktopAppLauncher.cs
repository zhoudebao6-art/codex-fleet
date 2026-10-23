using System;
using System.IO;
using System.Diagnostics;
using System.Web.Script.Serialization;
using System.Collections.Generic;

// Runs only the installed desktop application selected by the Fleet launcher.
// The package activation API does not inherit the caller's environment.
class DesktopAppLauncher {
  static int Main(string[] args) {
    string root=AppDomain.CurrentDomain.BaseDirectory;
    string requestId=null;
    var result=new Dictionary<string,object>();
    try {
      var json=new JavaScriptSerializer();
      var config=json.Deserialize<Dictionary<string,string>>(File.ReadAllText(Path.Combine(root,"desktop-launch.json")));
      requestId=config["requestId"];
      if(args.Length!=1 || args[0]!=requestId)throw new Exception("Desktop launch request changed; no application was started.");
      string app=Path.GetFullPath(config["appPath"]),packageRoot=Path.GetFullPath(config["packageRoot"]).TrimEnd('\\')+"\\";
      string name=Path.GetFileName(app);
      if(!app.StartsWith(packageRoot,StringComparison.OrdinalIgnoreCase) ||
         !(name.Equals("Codex.exe",StringComparison.OrdinalIgnoreCase)||name.Equals("ChatGPT.exe",StringComparison.OrdinalIgnoreCase)) || !File.Exists(app))
        throw new Exception("The desktop executable is not inside the selected installed package.");
      string bridge=Path.Combine(root,"codex-fleet-desktop.exe"),temp=@"D:\codex+\temp";
      if(!File.Exists(bridge)||!Directory.Exists(temp))throw new Exception("Fleet bridge or D: temporary directory is missing.");
      var start=new ProcessStartInfo(app){UseShellExecute=false,WorkingDirectory=Path.GetDirectoryName(app)};
      start.EnvironmentVariables["CODEX_CLI_PATH"]=bridge;
      start.EnvironmentVariables["TEMP"]=temp;start.EnvironmentVariables["TMP"]=temp;start.EnvironmentVariables["TMPDIR"]=temp;
      start.EnvironmentVariables["PSModuleAnalysisCachePath"]=@"D:\codex+\cache\powershell\ModuleAnalysisCache";
      using(var child=Process.Start(start)){result["status"]="started";result["pid"]=child.Id;}
    }catch(Exception e){result["status"]="failed";result["error"]=e.Message;}
    result["requestId"]=requestId;
    try{File.WriteAllText(Path.Combine(root,"desktop-launch-result.json"),new JavaScriptSerializer().Serialize(result));}catch{}
    return (string)result["status"]=="started"?0:1;
  }
}
