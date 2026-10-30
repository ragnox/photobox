package local.photobox.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.withLock
import local.photobox.api.HostApi
import local.photobox.api.PairingPayload

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val graph = (application as PhotoboxApplication).graph
    val connection = graph.connections.connection
    val settings = graph.settings.settings
    val assets = graph.database.assets().observe().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    val counts = graph.database.assets().counts().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    val access = MutableStateFlow(graph.catalog.access())
    val pairing = MutableStateFlow(false)
    val error = MutableStateFlow<String?>(null)

    fun connect(payload: String, name: String) = viewModelScope.launch {
        pairing.value = true; error.value = null
        try {
            val connection = HostApi.pair(PairingPayload.decode(payload), name)
            graph.scheduler.stop()
            withContext(Dispatchers.IO) {
                graph.backupMutex.withLock {
                    graph.connections.save(connection)
                    graph.database.assets().activate(connection.id)
                }
            }
            graph.settings.update { it.copy(error = null) }
            graph.scheduler.configure(restart = true); graph.scheduler.now(replace = true)
        } catch (e: Exception) { error.value = e.message ?: "Could not connect to the host" }
        finally { pairing.value = false }
    }

    fun accessChanged() = viewModelScope.launch {
        access.value = graph.catalog.access()
        (getApplication<Application>() as PhotoboxApplication).observeMedia()
        if (access.value.any) {
            try {
                val folders = graph.catalog.scan { }
                graph.settings.update { it.copy(knownFolders = folders) }
                graph.database.assets().retryErrors()
                graph.scheduler.now()
            } catch (e: Exception) { error.value = e.message }
        }
    }

    fun configure(change: (BackupSettings) -> BackupSettings) {
        graph.settings.update(change)
        graph.scheduler.configure(restart = true)
        graph.scheduler.now(replace = true)
    }

    fun backUpNow() = viewModelScope.launch {
        graph.settings.update { it.copy(paused = false, error = null) }
        graph.database.assets().retryErrors()
        graph.scheduler.configure(restart = true); graph.scheduler.now(replace = true)
    }

    fun forget() = viewModelScope.launch(Dispatchers.IO) {
        graph.scheduler.stop()
        graph.backupMutex.withLock { graph.connections.clear() }
        graph.scheduler.configure()
    }
}
