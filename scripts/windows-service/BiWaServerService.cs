using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.ServiceProcess;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("BI WA Servidor Online")]
[assembly: AssemblyDescription("Servico do Windows para manter o portal BI WA Online ativo")]
[assembly: AssemblyCompany("WA Solucoes")]
[assembly: AssemblyProduct("BI WA")]
[assembly: AssemblyVersion("3.2.93.0")]
[assembly: AssemblyFileVersion("3.2.93.0")]

namespace BiWa.ServerService
{
    internal static class Program
    {
        internal const string ServiceName = "BIWAServerOnline";

        [STAThread]
        private static void Main(string[] args)
        {
            if (args.Length > 0 && String.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                String output = args.Length > 1 ? args[1] : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "biwa-service-self-test.txt");
                File.WriteAllLines(output, BiWaOnlineService.BuildSelfTest());
                return;
            }

            if (Environment.UserInteractive)
            {
                RunInteractiveManager(args);
                return;
            }

            ServiceBase.Run(new ServiceBase[] { new BiWaOnlineService() });
        }

        private static void RunInteractiveManager(string[] args)
        {
            String action = "Instalar";
            if (args.Length > 0)
            {
                String requested = args[0].Trim().ToLowerInvariant();
                if (requested == "--uninstall" || requested == "--remove") action = "Remover";
                else if (requested == "--start") action = "Iniciar";
                else if (requested == "--stop") action = "Parar";
                else if (requested == "--restart") action = "Reiniciar";
                else if (requested == "--status") action = "Status";
            }

            String root = AppDomain.CurrentDomain.BaseDirectory;
            String script = Path.Combine(root, "gerenciar_servico_bi_wa.ps1");
            if (!File.Exists(script))
            {
                MessageBox.Show("O arquivo gerenciar_servico_bi_wa.ps1 nao foi encontrado na pasta do servidor.", "BI WA Servidor Online", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            if (action == "Instalar")
            {
                DialogResult answer = MessageBox.Show(
                    "Instalar ou atualizar o BI WA como servico automatico do Windows?\r\n\r\nO portal continuara no ar sem manter CMD ou PowerShell aberto.",
                    "BI WA Servidor Online",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question);
                if (answer != DialogResult.Yes) return;
            }

            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = "powershell.exe";
                startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Acao " + action;
                startInfo.WorkingDirectory = root;
                startInfo.UseShellExecute = true;
                startInfo.Verb = "runas";
                Process manager = Process.Start(startInfo);
                manager.WaitForExit();

                if (manager.ExitCode == 0)
                {
                    MessageBox.Show("Operacao concluida com sucesso.", "BI WA Servidor Online", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                else
                {
                    MessageBox.Show("A operacao nao foi concluida. Verifique a mensagem exibida e os logs da pasta logs.", "BI WA Servidor Online", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            }
            catch (System.ComponentModel.Win32Exception)
            {
                MessageBox.Show("A permissao de administrador foi cancelada.", "BI WA Servidor Online", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "BI WA Servidor Online", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    internal sealed class BiWaOnlineService : ServiceBase
    {
        private readonly Object processLock = new Object();
        private Process serverProcess;
        private System.Threading.Timer restartTimer;
        private Boolean stopping;
        private static readonly Object logLock = new Object();
        private static readonly String RootDirectory = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        private static readonly String LogsDirectory = Path.Combine(RootDirectory, "logs");
        private static readonly String ServiceLogPath = Path.Combine(LogsDirectory, "biwa-service.log");

        internal BiWaOnlineService()
        {
            ServiceName = Program.ServiceName;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            stopping = false;
            WriteLog("Servico iniciado pelo Windows.");
            StartServerProcess(true);
        }

        protected override void OnStop()
        {
            StopServerProcess("Servico interrompido.");
        }

        protected override void OnShutdown()
        {
            StopServerProcess("Windows em desligamento.");
            base.OnShutdown();
        }

        private void StartServerProcess(Boolean failServiceStart)
        {
            lock (processLock)
            {
                if (stopping || (serverProcess != null && !serverProcess.HasExited)) return;

                String serverScript = Path.Combine(RootDirectory, "server.js");
                String nodePath = ResolveNodePath();
                if (!File.Exists(serverScript))
                {
                    InvalidOperationException error = new InvalidOperationException("server.js nao encontrado em " + RootDirectory);
                    WriteLog(error.Message);
                    if (failServiceStart) throw error;
                    ScheduleRestart();
                    return;
                }
                if (String.IsNullOrEmpty(nodePath))
                {
                    InvalidOperationException error = new InvalidOperationException("Node.js nao encontrado. Instale o Node.js 20 ou defina BIWA_NODE_PATH.");
                    WriteLog(error.Message);
                    if (failServiceStart) throw error;
                    ScheduleRestart();
                    return;
                }

                try
                {
                    ProcessStartInfo startInfo = new ProcessStartInfo();
                    startInfo.FileName = nodePath;
                    startInfo.Arguments = "\"" + serverScript + "\"";
                    startInfo.WorkingDirectory = RootDirectory;
                    startInfo.UseShellExecute = false;
                    startInfo.CreateNoWindow = true;
                    startInfo.RedirectStandardOutput = true;
                    startInfo.RedirectStandardError = true;
                    startInfo.EnvironmentVariables["APP_MODE"] = "online";
                    startInfo.EnvironmentVariables["NODE_ENV"] = "production";

                    Process process = new Process();
                    process.StartInfo = startInfo;
                    process.EnableRaisingEvents = true;
                    process.OutputDataReceived += delegate(Object sender, DataReceivedEventArgs eventArgs)
                    {
                        if (!String.IsNullOrWhiteSpace(eventArgs.Data)) WriteLog("OUT " + eventArgs.Data);
                    };
                    process.ErrorDataReceived += delegate(Object sender, DataReceivedEventArgs eventArgs)
                    {
                        if (!String.IsNullOrWhiteSpace(eventArgs.Data)) WriteLog("ERR " + eventArgs.Data);
                    };
                    process.Exited += ServerProcessExited;

                    if (!process.Start()) throw new InvalidOperationException("O processo Node.js nao foi iniciado.");
                    serverProcess = process;
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    WriteLog("Portal iniciado. PID " + process.Id + ", Node " + nodePath);
                }
                catch (Exception error)
                {
                    serverProcess = null;
                    WriteLog("Falha ao iniciar o portal: " + error);
                    if (failServiceStart) throw;
                    ScheduleRestart();
                }
            }
        }

        private void ServerProcessExited(Object sender, EventArgs eventArgs)
        {
            Process exited = sender as Process;
            Int32 exitCode = -1;
            try { if (exited != null) exitCode = exited.ExitCode; }
            catch { }

            lock (processLock)
            {
                if (ReferenceEquals(serverProcess, exited)) serverProcess = null;
            }
            WriteLog("Portal encerrado com codigo " + exitCode + ".");
            if (!stopping) ScheduleRestart();
        }

        private void ScheduleRestart()
        {
            if (stopping) return;
            if (restartTimer != null) restartTimer.Dispose();
            WriteLog("Nova tentativa em 5 segundos.");
            restartTimer = new System.Threading.Timer(delegate(Object state)
            {
                try { StartServerProcess(false); }
                catch (Exception error) { WriteLog("Erro na reinicializacao: " + error.Message); }
            }, null, 5000, Timeout.Infinite);
        }

        private void StopServerProcess(String reason)
        {
            stopping = true;
            if (restartTimer != null)
            {
                restartTimer.Dispose();
                restartTimer = null;
            }

            Process process = null;
            lock (processLock)
            {
                process = serverProcess;
                serverProcess = null;
            }

            if (process != null)
            {
                try
                {
                    if (!process.HasExited)
                    {
                        ProcessStartInfo killInfo = new ProcessStartInfo("taskkill.exe", "/PID " + process.Id + " /T /F");
                        killInfo.UseShellExecute = false;
                        killInfo.CreateNoWindow = true;
                        Process killer = Process.Start(killInfo);
                        if (killer != null) killer.WaitForExit(10000);
                    }
                }
                catch (Exception error)
                {
                    WriteLog("Falha ao encerrar o processo Node.js: " + error.Message);
                    try { if (!process.HasExited) process.Kill(); }
                    catch { }
                }
                finally
                {
                    process.Dispose();
                }
            }
            WriteLog(reason);
        }

        internal static String[] BuildSelfTest()
        {
            List<String> lines = new List<String>();
            String nodePath = ResolveNodePath();
            lines.Add("BI WA Windows Service - self test");
            lines.Add("Root=" + RootDirectory);
            lines.Add("ServerJs=" + File.Exists(Path.Combine(RootDirectory, "server.js")));
            lines.Add("Env=" + File.Exists(Path.Combine(RootDirectory, ".env")));
            lines.Add("Public=" + Directory.Exists(Path.Combine(RootDirectory, "public")));
            lines.Add("Node=" + (String.IsNullOrEmpty(nodePath) ? "NOT_FOUND" : nodePath));
            lines.Add("Ready=" + (File.Exists(Path.Combine(RootDirectory, "server.js")) && Directory.Exists(Path.Combine(RootDirectory, "public")) && !String.IsNullOrEmpty(nodePath)));
            return lines.ToArray();
        }

        private static String ResolveNodePath()
        {
            List<String> candidates = new List<String>();
            String configured = Environment.GetEnvironmentVariable("BIWA_NODE_PATH");
            if (!String.IsNullOrWhiteSpace(configured)) candidates.Add(configured.Trim().Trim('"'));
            candidates.Add(Path.Combine(RootDirectory, "runtime", "node.exe"));
            candidates.Add(Path.Combine(RootDirectory, "node.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
            String programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            if (!String.IsNullOrEmpty(programFilesX86)) candidates.Add(Path.Combine(programFilesX86, "nodejs", "node.exe"));

            String pathValue = Environment.GetEnvironmentVariable("PATH") ?? String.Empty;
            String[] pathParts = pathValue.Split(new Char[] { Path.PathSeparator }, StringSplitOptions.RemoveEmptyEntries);
            foreach (String pathPart in pathParts)
            {
                try { candidates.Add(Path.Combine(pathPart.Trim().Trim('"'), "node.exe")); }
                catch { }
            }

            foreach (String candidate in candidates)
            {
                try { if (!String.IsNullOrWhiteSpace(candidate) && File.Exists(candidate)) return Path.GetFullPath(candidate); }
                catch { }
            }
            return String.Empty;
        }

        private static void WriteLog(String message)
        {
            lock (logLock)
            {
                try
                {
                    Directory.CreateDirectory(LogsDirectory);
                    if (File.Exists(ServiceLogPath) && new FileInfo(ServiceLogPath).Length > 20L * 1024L * 1024L)
                    {
                        String rotated = Path.Combine(LogsDirectory, "biwa-service.previous.log");
                        if (File.Exists(rotated)) File.Delete(rotated);
                        File.Move(ServiceLogPath, rotated);
                    }
                    File.AppendAllText(ServiceLogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine);
                }
                catch { }
            }
        }
    }
}
