#Requires -Version 5.1
<#
.SYNOPSIS
    Publishes the release tags of Crimson Noir AI Agent City from the operator's own machine.

.DESCRIPTION
    Why does this file exist? The agent sessions that build this project cannot push tags: their git proxy answers
    HTTP 403 to a tag push. This script is the operator's way to do it, with the operator's own GitHub credentials.
    It changes nothing but the two tags:
    1. It checks it is in a clone of the expected repository, and that git can sign annotated tags as someone.
    2. It fetches origin explicitly, including the branch the commit was pushed on.
    3. It resolves -Commit to a full commit and requires it to be on that branch as origin has it.
    4. For each tag: if origin already has it at this commit, nothing is done; if origin has it at another commit,
       it stops (moving a published tag is refused unless -Force, which says so loudly). The tag is made locally as an
       annotated tag (signed with -Sign), or reused if it already points at this commit.
    5. It pushes the tags in one atomic push, then reads them back from origin to prove where they landed.
    A tag push starts .github/workflows/build-release.yml only if the tagged commit contains that file (GitHub runs
    the workflow as it is at the tagged commit); the script says which it is before pushing anything.
    -WhatIf shows every step without making or pushing a tag.
    What breaks if it is removed? Nothing at run time; the release tags stay unpublished.

.EXAMPLE
    .\publish.ps1
    Tags cb99379 as v1.0.0-stable-release and stable-beta and pushes both to origin.

.EXAMPLE
    .\publish.ps1 -Commit 0123abc -WhatIf
    Shows what would be tagged and pushed, and does neither.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # The commit to tag: a full or abbreviated hash, or any name git resolves to a commit.
    [string] $Commit = 'cb99379',
    [string[]] $Tags = @('v1.0.0-stable-release', 'stable-beta'),
    [string] $Remote = 'origin',
    # The branch on the remote that must contain the commit.
    [string] $Branch = 'claude/quirky-faraday-xkpdln',
    # owner/name the remote's URL must name, so the script never tags another repository by mistake.
    [string] $Repository = 'exitwoundscassius-ux/Crimson-Noir-AI-Agent-City',
    # Sign the tags with the operator's GPG or SSH signing key (git tag -s).
    [switch] $Sign,
    # Move a tag that already exists at another commit, locally and on the remote. Rewrites published history.
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# PowerShell 7.3+ could turn a native command's exit code into an error by itself; this script checks every exit code.
$PSNativeCommandUseErrorActionPreference = $false

# Runs git and returns its output as lines of text. Git writes progress to standard error, which Windows PowerShell
# would otherwise raise as an error, so standard error is folded into the output and the exit code decides.
function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)] [string[]] $Arguments,
        [switch] $AllowFailure
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& git @Arguments 2>&1 | ForEach-Object { "$_" })
    }
    finally {
        $ErrorActionPreference = $previous
    }
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "git $($Arguments -join ' ') failed with exit code ${code}:`n$($output -join "`n")"
    }
    return [pscustomobject]@{ Code = $code; Output = $output }
}

# The commit a tag on the remote points at (peeled through an annotated tag), or $null when the remote has no such tag.
function Get-RemoteTagCommit {
    param([Parameter(Mandatory = $true)] [string] $Name)
    $lines = (Invoke-Git -Arguments @('ls-remote', '--tags', $Remote, "refs/tags/$Name", "refs/tags/$Name^{}")).Output
    $plain = $null
    $peeled = $null
    foreach ($line in $lines) {
        $parts = $line -split '\s+'
        if ($parts.Count -lt 2) { continue }
        if ($parts[1] -eq "refs/tags/$Name^{}") { $peeled = $parts[0] }
        elseif ($parts[1] -eq "refs/tags/$Name") { $plain = $parts[0] }
    }
    if ($null -ne $peeled) { return $peeled }
    return $plain
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is not on PATH.' }
$top = (Invoke-Git -Arguments @('rev-parse', '--show-toplevel')).Output | Select-Object -First 1
Push-Location -LiteralPath $top
try {
    # 1. The right repository, and someone to sign the tags as.
    $url = (Invoke-Git -Arguments @('remote', 'get-url', $Remote)).Output | Select-Object -First 1
    $wanted = [regex]::Escape($Repository) + '(\.git)?/?$'
    if ($url -notmatch $wanted) {
        throw "Remote '$Remote' is $url, not $Repository. Run this in a clone of $Repository, or pass -Repository."
    }
    $who = (Invoke-Git -Arguments @('config', 'user.email') -AllowFailure).Output | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($who)) {
        throw 'git has no user.email; annotated tags need a tagger: git config --global user.email you@example.com'
    }
    foreach ($tag in $Tags) {
        if ((Invoke-Git -Arguments @('check-ref-format', "refs/tags/$tag") -AllowFailure).Code -ne 0) {
            throw "'$tag' is not a valid tag name."
        }
    }
    Write-Host "Repository: $url (tagger $who)"

    # 2. Fetch origin explicitly, and the branch the commit must be on.
    Write-Host "Fetching $Remote ..."
    Invoke-Git -Arguments @('fetch', '--prune', $Remote) | Out-Null
    Invoke-Git -Arguments @('fetch', $Remote, "+refs/heads/${Branch}:refs/remotes/$Remote/$Branch") | Out-Null

    # 3. The commit, in full, and on the published branch.
    $resolved = Invoke-Git -Arguments @('rev-parse', '--verify', '--quiet', "$Commit^{commit}") -AllowFailure
    if ($resolved.Code -ne 0) { throw "'$Commit' is not a commit in this clone, even after the fetch." }
    $sha = $resolved.Output | Select-Object -First 1
    $reachable = Invoke-Git -Arguments @('merge-base', '--is-ancestor', $sha, "refs/remotes/$Remote/$Branch") -AllowFailure
    if ($reachable.Code -ne 0) { throw "$sha is not on $Remote/${Branch}: only published history is tagged." }
    $subject = (Invoke-Git -Arguments @('log', '-1', '--format=%s', $sha)).Output | Select-Object -First 1
    Write-Host "Commit:     $sha ($subject)"

    $hasWorkflow = (Invoke-Git -Arguments @('cat-file', '-e', "${sha}:.github/workflows/build-release.yml") -AllowFailure).Code -eq 0
    if ($hasWorkflow) {
        Write-Host 'Pipeline:   this commit has .github/workflows/build-release.yml: each tag pushed starts a release bake.'
    }
    else {
        Write-Warning ("$($sha.Substring(0, 7)) predates .github/workflows/build-release.yml, so pushing these tags starts no " +
            'release bake (GitHub runs the workflow as it is at the tagged commit). To get the bake, tag a commit that has ' +
            'the file (-Commit), or, once the file is on the default branch, run the workflow by hand for each tag.')
    }

    # 4. Each tag: already published here, refused elsewhere (unless -Force), made or reused locally.
    $refspecs = New-Object System.Collections.Generic.List[string]
    foreach ($tag in $Tags) {
        $remoteAt = Get-RemoteTagCommit -Name $tag
        if ($remoteAt -eq $sha) {
            Write-Host "Tag $tag is already on $Remote at $($sha.Substring(0, 12)): nothing to do."
            continue
        }
        $move = $false
        if ($null -ne $remoteAt) {
            if (-not $Force) {
                throw "$Remote already has $tag at $remoteAt, not $sha. Moving a published tag rewrites history; pass -Force only if that is intended."
            }
            Write-Warning "-Force: $tag will be MOVED on $Remote from $remoteAt to $sha."
            $move = $true
        }

        $local = Invoke-Git -Arguments @('rev-parse', '--verify', '--quiet', "refs/tags/$tag^{commit}") -AllowFailure
        $localAt = if ($local.Code -eq 0) { $local.Output | Select-Object -First 1 } else { $null }
        if ($localAt -eq $sha) {
            Write-Host "Tag $tag already points at $($sha.Substring(0, 12)) locally."
        }
        else {
            if ($null -ne $localAt) {
                if (-not $Force) {
                    throw "The local tag $tag points at $localAt, not $sha. Delete it (git tag -d $tag) or pass -Force."
                }
                Write-Warning "-Force: the local tag $tag will be remade at $sha (it was $localAt)."
            }
            if ($PSCmdlet.ShouldProcess("$tag -> $sha", 'Create annotated tag')) {
                $message = "$tag`n`nCrimson Noir AI Agent City at $($sha.Substring(0, 12)): $subject`nPublished with publish.ps1 by $who."
                $file = [System.IO.Path]::GetTempFileName()
                try {
                    # UTF-8 without a byte-order mark, which git would otherwise keep at the start of the message.
                    [System.IO.File]::WriteAllText($file, $message, (New-Object System.Text.UTF8Encoding($false)))
                    $create = @('tag', $(if ($Sign) { '-s' } else { '-a' }))
                    if ($null -ne $localAt) { $create += '-f' }
                    Invoke-Git -Arguments ($create + @('-F', $file, $tag, $sha)) | Out-Null
                }
                finally {
                    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
                }
                Write-Host "Tag $tag created at $($sha.Substring(0, 12))."
            }
        }
        $refspecs.Add($(if ($move) { '+' } else { '' }) + "refs/tags/${tag}:refs/tags/$tag")
    }

    # 5. One atomic push of every tag that needs it, then the remote read back.
    if ($refspecs.Count -eq 0) {
        Write-Host "Every tag is already on $Remote at $($sha.Substring(0, 12))."
        return
    }
    if (-not $PSCmdlet.ShouldProcess("$Remote ($($refspecs -join ', '))", 'Push tags')) { return }
    Invoke-Git -Arguments (@('push', '--atomic', $Remote) + $refspecs.ToArray()) | Out-Null
    foreach ($tag in $Tags) {
        $at = Get-RemoteTagCommit -Name $tag
        if ($at -ne $sha) { throw "After the push, $Remote has $tag at '$at', not $sha." }
        Write-Host "Published: $tag -> $sha"
    }
    $web = 'https://github.com/' + $Repository
    if ($hasWorkflow) { Write-Host "Release bakes: $web/actions/workflows/build-release.yml" }
    Write-Host "Releases:      $web/releases"
}
finally {
    Pop-Location
}
