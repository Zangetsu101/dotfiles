param(
    [string]$Prompt = "Enter your SSH key passphrase"
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore

$window = New-Object System.Windows.Window
$window.Title = "SSH authentication"
$window.Width = 500
$window.SizeToContent = "Height"
$window.ResizeMode = "NoResize"
$window.WindowStartupLocation = "CenterScreen"
$window.Topmost = $true
$window.ShowInTaskbar = $true
$window.FontFamily = "Segoe UI"
$window.FontSize = 14
$window.Background = "#F8F9FB"

$panel = New-Object System.Windows.Controls.StackPanel
$panel.Margin = 28

$heading = New-Object System.Windows.Controls.TextBlock
$heading.Text = "Unlock your SSH key"
$heading.FontSize = 20
$heading.FontWeight = "SemiBold"
$heading.Foreground = "#202124"
$heading.Margin = "0,0,0,8"
[void]$panel.Children.Add($heading)

$label = New-Object System.Windows.Controls.TextBlock
$label.Text = $Prompt
$label.Foreground = "#5F6368"
$label.Margin = "0,0,0,14"
$label.TextWrapping = "Wrap"
[void]$panel.Children.Add($label)

$password = New-Object System.Windows.Controls.PasswordBox
$password.Height = 34
$password.FontSize = 16
$password.Padding = "8,4"
$password.Margin = "0,0,0,20"
$password.BorderBrush = "#B8BDC7"
$password.BorderThickness = 1
$password.Background = "White"
[void]$panel.Children.Add($password)

$buttons = New-Object System.Windows.Controls.StackPanel
$buttons.Orientation = "Horizontal"
$buttons.HorizontalAlignment = "Right"

$cancel = New-Object System.Windows.Controls.Button
$cancel.Content = "Cancel"
$cancel.Width = 88
$cancel.Height = 34
$cancel.Margin = "0,0,10,0"
$cancel.IsCancel = $true
$cancel.Add_Click({ $window.DialogResult = $false })
[void]$buttons.Children.Add($cancel)

$ok = New-Object System.Windows.Controls.Button
$ok.Content = "Unlock"
$ok.Width = 88
$ok.Height = 34
$ok.IsDefault = $true
$ok.FontWeight = "SemiBold"
$ok.Add_Click({ $window.DialogResult = $true })
[void]$buttons.Children.Add($ok)

[void]$panel.Children.Add($buttons)
$window.Content = $panel
$window.Add_ContentRendered({ [void]$password.Focus() })

if ($window.ShowDialog() -ne $true) {
    exit 1
}

# OpenSSH's askpass protocol expects one LF-terminated UTF-8 line. Windows
# PowerShell's WriteLine emits CRLF and uses the console's legacy encoding,
# either of which can alter the passphrase seen by WSL.
$output = [Text.UTF8Encoding]::new($false).GetBytes($password.Password + "`n")
[Console]::OpenStandardOutput().Write($output, 0, $output.Length)
