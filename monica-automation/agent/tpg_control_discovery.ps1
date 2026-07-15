Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Write-AutomationTree {
    param(
        [System.Windows.Automation.AutomationElement]$Element,
        [int]$Depth = 0
    )
    $indent = "  " * $Depth
    $name = $Element.Current.Name
    $autoId = $Element.Current.AutomationId
    $className = $Element.Current.ClassName
    $controlType = $Element.Current.ControlType.ProgrammaticName
    Write-Output "$indent[$controlType] Name='$name' AutomationId='$autoId' ClassName='$className'"

    $children = $Element.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($child in $children) {
        Write-AutomationTree -Element $child -Depth ($Depth + 1)
    }
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$topLevel = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
)
$targets = $topLevel | Where-Object { $_.Current.Name -like "*Monica*" }

if (-not $targets) {
    Write-Output "No top-level window with 'Monica' in its title was found."
    Write-Output "Make sure MonicaTPGenerator.exe is open, then re-run this script."
} else {
    foreach ($t in $targets) {
        Write-Output "===== Window: $($t.Current.Name) ====="
        Write-AutomationTree -Element $t
    }
}
