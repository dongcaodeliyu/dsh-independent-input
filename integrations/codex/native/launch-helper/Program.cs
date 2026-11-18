// Fixed single-shot ShellExecute helper. No window, UIA, input or activation API.
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Web.Script.Serialization;
class LaunchHelper {
 [StructLayout(LayoutKind.Sequential)] struct POINT {public int X,Y;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct INFO {public int cbSize;public uint fMask;public IntPtr hwnd;public string verb,file,parameters,directory;public int show;public IntPtr instance,idList;public string cls;public IntPtr key;public uint hotKey;public IntPtr monitor,process;}
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ShellExecuteExW(ref INFO info);
 [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT point,uint flags);
 [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static StreamWriter writer;static object sync=new object();static JavaScriptSerializer json=new JavaScriptSerializer();static string stage="connecting";static long started;
 static void Emit(string name,object data=null){lock(sync){stage=name;writer.WriteLine(json.Serialize(new{stage=name,utc=DateTime.UtcNow.ToString("o"),ticks=Stopwatch.GetTimestamp(),frequency=Stopwatch.Frequency,helperPid=Process.GetCurrentProcess().Id,helperBirth=Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString(),threadId=GetCurrentThreadId(),apartment=Thread.CurrentThread.GetApartmentState().ToString(),data=data}));writer.Flush();}}
 [STAThread] static int Main(string[] args){
  if(args.Length!=0)return 2;
  started=Stopwatch.GetTimestamp();
  try{using(var input=Console.OpenStandardInput())using(var output=Console.OpenStandardOutput()){
   var reader=new StreamReader(input,new System.Text.UTF8Encoding(false));writer=new StreamWriter(output,new System.Text.UTF8Encoding(false)){AutoFlush=true};
   var request=json.Deserialize<Dictionary<string,object>>(reader.ReadLine());
   string path=(string)request["path"];if(string.IsNullOrEmpty(path)||!Path.IsPathRooted(path)||(!File.Exists(path)&&!Directory.Exists(path)))return 4;
   int x=Convert.ToInt32(request["x"]),y=Convert.ToInt32(request["y"]);
   Emit("received",new{mask="0x00200140",show=4,cwd="shell-default"});
   // Only a cancellation/EOF channel remains. Native-enter cannot be undone.
   var watch=new Thread(()=>{try{reader.ReadLine();}catch{}Environment.Exit(0);});watch.IsBackground=true;watch.Start();
   var info=new INFO{cbSize=Marshal.SizeOf(typeof(INFO)),fMask=0x00200140,verb="open",file=path,show=4,monitor=MonitorFromPoint(new POINT{X=x,Y=y},2)};
   Emit("native-enter");
   try{bool ok=ShellExecuteExW(ref info);int error=ok?0:Marshal.GetLastWin32Error();uint pid=info.process==IntPtr.Zero?0:GetProcessId(info.process);string birth=null;bool? exited=null;int? exitCode=null;
    if(pid!=0){try{var p=Process.GetProcessById((int)pid);birth=p.StartTime.ToUniversalTime().Ticks.ToString();exited=p.HasExited;if(exited==true)exitCode=p.ExitCode;}catch{}}
    Emit("native-return",new{accepted=ok,win32Error=error,applicationPid=pid,applicationBirth=birth,applicationExited=exited,applicationExitCode=exitCode});
   }finally{if(info.process!=IntPtr.Zero)CloseHandle(info.process);}
   return 0;
  }}catch{return 5;}
 }
}
