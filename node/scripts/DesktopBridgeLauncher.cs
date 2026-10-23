using System;
using System.IO;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Collections.Generic;
class DesktopBridgeLauncher {
  static async Task Pump(Stream from, Stream to) {
    byte[] buffer=new byte[16384];int count;
    while((count=await from.ReadAsync(buffer,0,buffer.Length))>0){
      await to.WriteAsync(buffer,0,count);await to.FlushAsync();
    }
  }
  static string Quote(string value) {
    var result="\"";int slashes=0;
    foreach(char ch in value){if(ch=='\\'){slashes++;continue;}if(ch=='"')result+=new string('\\',slashes*2+1)+ch;else result+=new string('\\',slashes)+ch;slashes=0;}
    return result+new string('\\',slashes*2)+"\"";
  }
  static int Main(string[] args) {
    try {
      string config=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"launcher.json");
      var values=new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(File.ReadAllText(config));
      string arguments=Quote(values["adapterPath"])+" "+Quote(config);
      foreach(string arg in args)arguments+=" "+Quote(arg);
      var start=new ProcessStartInfo(values["nodePath"],arguments){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
      using(var process=Process.Start(start)) {
        var input=Pump(Console.OpenStandardInput(),process.StandardInput.BaseStream).ContinueWith(t=>{try{process.StandardInput.Close();}catch{}});
        var output=Pump(process.StandardOutput.BaseStream,Console.OpenStandardOutput());
        var error=Pump(process.StandardError.BaseStream,Console.OpenStandardError());
        process.WaitForExit();Task.WaitAll(output,error);return process.ExitCode;
      }
    }catch(Exception){Console.Error.WriteLine("Fleet desktop bridge could not start. Use the original Codex shortcut or inspect the Fleet bridge installation.");return 1;}
  }
}
