package local.photobox.android

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { MaterialTheme { BackupScreen() } }
    }
}

@Composable
private fun BackupScreen(model: MainViewModel = viewModel()) {
    val connection by model.connection.collectAsStateWithLifecycle()
    val settings by model.settings.collectAsStateWithLifecycle()
    val assets by model.assets.collectAsStateWithLifecycle()
    val counts by model.counts.collectAsStateWithLifecycle()
    val access by model.access.collectAsStateWithLifecycle()
    val pairing by model.pairing.collectAsStateWithLifecycle()
    val error by model.error.collectAsStateWithLifecycle()
    val deletionRequests by model.deletionRequests.collectAsStateWithLifecycle()
    var asked by remember { mutableStateOf<List<Asset>>(emptyList()) }
    val scope = rememberCoroutineScope()
    var payload by remember { mutableStateOf("") }
    var name by remember { mutableStateOf(Build.MODEL) }
    var pairAnother by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { model.accessChanged() }
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val scan = rememberLauncherForActivityResult(ScanContract()) { result -> result.contents?.let { payload = it } }
    // Android's own question before photos the camera made go to the trash; the answer is read back from MediaStore.
    val trash = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { model.trashAnswered(asked) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { model.accessChanged() }
    LaunchedEffect(connection?.id) { if (connection != null) { payload = ""; pairAnother = false } }

    Scaffold { padding ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Spacer(Modifier.height(12.dp))
                Text("Photobox", style = MaterialTheme.typography.headlineLarge)
                Text("Original photos, on a disk you own.")
            }
            if (deletionRequests.isNotEmpty()) item {
                val n = deletionRequests.size
                Text("Deleted in Photobox", style = MaterialTheme.typography.titleLarge)
                Text(if (n == 1) "You deleted ${deletionRequests[0].filename} in Photobox. It is still on this phone."
                    else "You deleted $n photos in Photobox. They are still on this phone.")
                if (Build.VERSION.SDK_INT >= 30) {
                    Text("Android asks you to confirm before they move to this phone's trash.", style = MaterialTheme.typography.bodySmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { scope.launch {
                            model.trashRequest()?.let { (sender, assets) -> asked = assets; trash.launch(IntentSenderRequest.Builder(sender).build()) }
                        } }) { Text("Delete from this phone") }
                        OutlinedButton(onClick = { model.keep(deletionRequests) }) { Text("Keep") }
                    }
                } else {
                    Text("Android 10 doesn't let other apps delete photos: delete them in your gallery app, or keep them.", style = MaterialTheme.typography.bodySmall)
                    deletionRequests.take(20).forEach { Text(it.filename, style = MaterialTheme.typography.bodySmall) }
                    OutlinedButton(onClick = { model.keep(deletionRequests) }) { Text("Keep") }
                }
            }
            item {
                connection?.let { host ->
                    Text(host.server, style = MaterialTheme.typography.titleMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { pairAnother = !pairAnother }) { Text("Pair another host") }
                        TextButton(onClick = { model.forget() }) { Text("Forget host") }
                    }
                }
            }
            if (connection == null || pairAnother) item {
                Text("Connect to your host", style = MaterialTheme.typography.titleLarge)
                Text("On the computer, choose Connect a phone → Photobox for Android.")
                Button(onClick = { scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the Android QR in Photobox on your computer").setBeepEnabled(false).setOrientationLocked(false)) }, enabled = !pairing) { Text("Scan host QR") }
                OutlinedTextField(value = payload, onValueChange = { payload = it }, label = { Text("Or paste Android pairing data") }, modifier = Modifier.fillMaxWidth(), maxLines = 4)
                OutlinedTextField(value = name, onValueChange = { name = it.take(60) }, label = { Text("Phone name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button(onClick = { model.connect(payload, name) }, enabled = payload.isNotBlank() && !pairing) { Text(if (pairing) "Connecting…" else "Connect") }
            }
            item {
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                settings.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Text("Photo access", style = MaterialTheme.typography.titleLarge)
                Text(when {
                    !access.any -> "Choose photos and videos to back up."
                    access.limited -> "Limited access: only selected photos/videos can be backed up. Grant full access for automatic camera-folder discovery."
                    else -> "Photo/video access granted."
                })
                if (!access.location) Text("Photo location access is needed to read exact originals without stripping GPS.")
                OutlinedButton(onClick = { permissions.launch(mediaPermissions()) }) { Text("Grant photo access") }
                if (!access.any || !access.location || access.limited) TextButton(onClick = {
                    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
                }) { Text("Open Android app settings") }
            }
            item {
                Text("Backup settings", style = MaterialTheme.typography.titleLarge)
                Setting("Unmetered network only", settings.unmetered) { value -> model.configure { it.copy(unmetered = value) } }
                Setting("Only while charging", settings.charging) { value -> model.configure { it.copy(charging = value) } }
                Text("Battery must not be low. Background work resumes when Android permits it.", style = MaterialTheme.typography.bodySmall)
            }
            item { Text("Folders", style = MaterialTheme.typography.titleLarge) }
            items((settings.knownFolders + settings.folders).sorted(), key = { "folder:$it" }) { folder ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(folder.ifEmpty { "Media root" }, modifier = Modifier.weight(1f))
                    Checkbox(checked = folder in settings.folders, onCheckedChange = { selected ->
                        model.configure { it.copy(folders = if (selected) it.folders + folder else it.folders - folder) }
                    })
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = {
                        if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                        model.backUpNow()
                    }, enabled = connection != null && access.any && settings.folders.isNotEmpty()) { Text(if (settings.paused) "Resume backup" else "Back up now") }
                    OutlinedButton(onClick = { model.configure { it.copy(paused = true) } }, enabled = !settings.paused) { Text("Pause") }
                }
                if (settings.paused) Text("Backup paused")
                Text("${counts.sumOf { it.count }} tracked originals · ${counts.find { it.state == AssetState.VERIFIED }?.count ?: 0} export verified")
                if (settings.lastRun > 0) Text("Last run: ${date(settings.lastRun)}", style = MaterialTheme.typography.bodySmall)
                if (settings.lastSuccess > 0) Text("Last completed run: ${date(settings.lastSuccess)}", style = MaterialTheme.typography.bodySmall)
                Text("Photobox deletes nothing here by itself: a photo you delete in Photobox goes to this phone's trash once you confirm it.", style = MaterialTheme.typography.bodySmall)
                connection?.let { host ->
                    TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(host.server))) }) { Text("Open host in browser") }
                    Text("Browser pairing is separate from Android backup.", style = MaterialTheme.typography.bodySmall)
                }
            }
            item { Text("Recent originals", style = MaterialTheme.typography.titleLarge) }
            items(assets, key = { it.id }) { asset ->
                Column(Modifier.fillMaxWidth()) {
                    Text(asset.filename, style = MaterialTheme.typography.titleMedium)
                    Text(when (asset.state) {
                        AssetState.VERIFIED -> "Export verified ${asset.verifiedAt?.let(::date) ?: ""}"
                        AssetState.AWAITING_HOST -> if (asset.indexed) "Indexed · awaiting verified export" else "Received · awaiting host processing"
                        AssetState.UPLOADING -> "Uploading ${asset.offset / 1024} / ${asset.size / 1024} KiB"
                        AssetState.ERROR -> "Will retry"
                        AssetState.BLOCKED -> "Needs attention"
                        AssetState.UNAVAILABLE -> "Original unavailable or changing"
                        AssetState.DELETE_REQUESTED -> "Deleted in Photobox · waiting for you to delete it here"
                        AssetState.TRASHED -> "Deleted in Photobox and on this phone"
                        AssetState.KEPT -> "Deleted in Photobox · kept on this phone"
                        else -> "Waiting for backup"
                    }, style = MaterialTheme.typography.bodySmall)
                    asset.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@Composable private fun Setting(label: String, checked: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, modifier = Modifier.weight(1f)); Switch(checked = checked, onCheckedChange = change)
    }
}

private fun date(millis: Long) = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(millis))

private fun mediaPermissions(): Array<String> = buildList {
    if (Build.VERSION.SDK_INT >= 33) { add(Manifest.permission.READ_MEDIA_IMAGES); add(Manifest.permission.READ_MEDIA_VIDEO) }
    else add(Manifest.permission.READ_EXTERNAL_STORAGE)
    if (Build.VERSION.SDK_INT >= 34) add(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
    add(Manifest.permission.ACCESS_MEDIA_LOCATION)
}.toTypedArray()
